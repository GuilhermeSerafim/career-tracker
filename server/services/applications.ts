import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { normalizeJobUrl, normalizeTrack } from '../../domain/identity.js';
import { commandSchema, evidenceInputSchema } from '../../shared/commands.js';
import type { Command } from '../../shared/commands';
import { applicationResultSchema } from '../../shared/application-results.js';
import type { ApplicationResult } from '../../shared/application-results';
import { canonicalRequestHash, createMutation } from '../mutation.js';
import type { AggregateRef, MutationContext } from '../mutation';
import type { createDatabase } from '../database';
import { SafeError } from '../errors.js';
import { applicationProjection, listResumeRefs } from '../repositories/career.js';
import { appendStageEvent } from '../repositories/activity.js';
import { allocateApplication, allocationPlan, allocationRefs } from '../repositories/reviews.js';
import { lockApplicationIdentity, resolveOpportunityIdentity } from '../repositories/identities.js';

type EvidenceInput = z.infer<typeof evidenceInputSchema>;
type Save = Extract<Command, { operation: 'save_application' }>;
type Ref = { id: string; expectedVersion: number };
type ApplicationRow = { id: string; version: number; opportunity_id: string; normalized_track: string; application_instance: string; canonical_application_id: string | null; submission_status: string; counting_eligible: boolean; archived_at: Date | null; stage: string };
const emptyResult = (): ApplicationResult => ({ application: null, resumeRef: null, existing: false, warnings: [], eligibilityChanges: [], affectedBatches: [], allocationPending: false });
const eligible = (row: ApplicationRow) => row.submission_status === 'confirmado' && row.counting_eligible && row.canonical_application_id === null;
const unknownDate = { precision: 'unknown', value: null } as const;

async function applicationRow(context: MutationContext, id: string): Promise<ApplicationRow> {
  const row = (await context.transaction.query<ApplicationRow>('SELECT id,version,opportunity_id,normalized_track,application_instance,canonical_application_id,submission_status,counting_eligible,archived_at,stage FROM career.applications WHERE owner_id=$1 AND id=$2', [context.ownerId, id])).rows[0];
  if (!row) throw new SafeError('NOT_FOUND'); return row;
}
function checkVersion(row: { version: number }, ref: Ref) {
  if (row.version !== ref.expectedVersion) throw new SafeError('CONFLICT', { details: { currentVersion: row.version, changedFields: [] } });
}
async function canonicalId(context: MutationContext, id: string): Promise<string> {
  const seen = new Set<string>(); let current = id;
  while (!seen.has(current)) {
    seen.add(current); const row = await applicationRow(context, current);
    if (!row.canonical_application_id) return current;
    current = row.canonical_application_id;
  }
  throw new SafeError('CONFLICT');
}
// Lock de domínio antes das linhas: serialização conservadora de identidades/clientIds.
// Compartilhado entre atores e operações, sem namespace escolhido pelo cliente.
async function domainLock(context: MutationContext) {
  await lockApplicationIdentity(context.transaction, context.ownerId);
}
const creationColumns = { application: 'result_application_id', resume_ref: 'result_resume_id', evidence: 'result_evidence_id' } as const;
async function priorCreation(context: MutationContext, entity: keyof typeof creationColumns, clientId: string, payload: unknown) {
  const row = (await context.transaction.query<{ payload_hash: string; result_id: string }>(`SELECT payload_hash,${creationColumns[entity]} AS result_id FROM career.creation_requests WHERE owner_id=$1 AND entity_type=$2 AND client_id=$3`, [context.ownerId, entity, clientId])).rows[0];
  if (row && row.payload_hash !== canonicalRequestHash(payload)) throw new SafeError('IDEMPOTENCY_CONFLICT');
  return row?.result_id;
}
async function mapCreation(context: MutationContext, entity: keyof typeof creationColumns, clientId: string, payload: unknown, id: string) {
  await context.transaction.query(`INSERT INTO career.creation_requests(owner_id,entity_type,client_id,payload_hash,${creationColumns[entity]}) VALUES($1,$2,$3,$4,$5)`, [context.ownerId, entity, clientId, canonicalRequestHash(payload), id]);
}
async function resolveEvidence(context: MutationContext, input: EvidenceInput): Promise<string> {
  if ('id' in input) {
    if (!(await context.transaction.query('SELECT id FROM career.evidence WHERE owner_id=$1 AND id=$2', [context.ownerId, input.id])).rowCount) throw new SafeError('NOT_FOUND');
    return input.id;
  }
  const prior = await priorCreation(context, 'evidence', input.clientId, input); if (prior) return prior;
  const id = randomUUID();
  await context.transaction.query('INSERT INTO career.evidence(id,owner_id,kind,original_text,source,occurred_date,private_ref,local_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, context.ownerId, input.kind, input.originalText, input.source, input.occurredDate, input.privateRef, input.localRef]);
  await mapCreation(context, 'evidence', input.clientId, input, id); return id;
}
async function event(context: MutationContext, applicationId: string, kind: 'envio_confirmado' | 'nota' | 'correcao', evidenceId: string | null, occurredDate: unknown, reason: string | null = null) {
  await context.transaction.query("INSERT INTO career.events(owner_id,application_id,kind,state,evidence_id,occurred_date,result_text) VALUES($1,$2,$3,'informado',$4,$5,$6)", [context.ownerId, applicationId, kind, evidenceId, occurredDate, reason]);
}
async function appendLinks(context: MutationContext, applicationId: string, links: Save['data']['links']) {
  for (const link of links) {
    let comparison: string | null = null;
    if (!link.isLocal) {
      try { comparison = normalizeJobUrl(link.originalUrl); }
      catch { throw new SafeError('INVALID_INPUT'); }
    }
    await context.transaction.query(`INSERT INTO career.links(owner_id,application_id,original_url,comparison_url,kind,is_local,is_private)
      SELECT $1,$2,$3,$4,$5,$6,$7 WHERE NOT EXISTS(SELECT 1 FROM career.links WHERE owner_id=$1 AND application_id=$2 AND original_url=$3 AND kind=$5 AND is_local=$6 AND is_private=$7)`, [context.ownerId, applicationId, link.originalUrl, comparison, link.kind, link.isLocal, link.isPrivate]);
  }
}
async function selectResumes(context: MutationContext, applicationId: string, ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new SafeError('INVALID_INPUT');
  const refs = await context.transaction.query('SELECT id FROM career.resume_refs WHERE owner_id=$1 AND id=ANY($2::uuid[])', [context.ownerId, ids]);
  if (refs.rowCount !== ids.length) throw new SafeError('NOT_FOUND');
  await context.transaction.query(`UPDATE career.application_resumes SET is_active=false,version=version+1,updated_at=now()
    WHERE owner_id=$1 AND application_id=$2 AND is_active AND NOT(resume_id=ANY($3::uuid[]))`, [context.ownerId, applicationId, ids]);
  for (const id of ids) await context.transaction.query(`INSERT INTO career.application_resumes(owner_id,application_id,resume_id) VALUES($1,$2,$3)
    ON CONFLICT(owner_id,application_id,resume_id) DO UPDATE SET is_active=true,version=career.application_resumes.version+1,updated_at=now() WHERE NOT career.application_resumes.is_active`, [context.ownerId, applicationId, id]);
}
async function projectionResult(context: MutationContext, id: string, result = emptyResult()) {
  result.application = await applicationProjection(context.transaction, context.ownerId, id);
  result.allocationPending = result.application.submissionStatus === 'confirmado' && result.application.countingEligible && result.application.canonicalApplicationId === null && result.application.cycleRelation === 'after_reset' && result.application.cycleOrder === null;
  return result;
}

async function saveApplication(context: MutationContext, command: Save) {
  const prior = await priorCreation(context, 'application', command.clientId, command);
  if (prior) { const result = emptyResult(); result.existing = true; return { status: 200, body: await projectionResult(context, await canonicalId(context, prior), result) }; }
  const data = command.data; const input = data.opportunity;
  const identities = [...input.identities];
  if (input.platform?.trim() && input.tenant?.trim() && input.jobCode?.trim()) identities.push({ provider: input.platform.trim(), tenant: input.tenant.trim(), kind: 'job_code', value: input.jobCode.trim(), verificationEvidence: null });
  let opportunityId = await resolveOpportunityIdentity(context.transaction, context.ownerId, identities);
  if (opportunityId) {
    const existing = (await context.transaction.query<{ id: string }>('SELECT id FROM career.applications WHERE owner_id=$1 AND opportunity_id=$2 AND normalized_track=$3 AND application_instance=$4 ORDER BY canonical_application_id NULLS FIRST,id', [context.ownerId, opportunityId, normalizeTrack(data.track), data.applicationInstance])).rows[0];
    if (existing) {
      const result = emptyResult(); result.existing = true;
      const canonical = await canonicalId(context, existing.id);
      // Só o alias durável é persistido: nenhum registro/evidência provisório foi criado.
      await mapCreation(context, 'application', command.clientId, command, canonical);
      return { status: 200, body: await projectionResult(context, canonical, result) };
    }
  }
  const result = emptyResult();
  const similar = await context.transaction.query<{ id: string }>(`SELECT a.id FROM career.applications a JOIN career.opportunities o ON o.id=a.opportunity_id AND o.owner_id=a.owner_id
    WHERE a.owner_id=$1 AND o.company=$2 AND o.title=$3 AND a.canonical_application_id IS NULL ORDER BY a.id LIMIT 100`, [context.ownerId, input.company, input.title]);
  result.warnings = similar.rows.map((row) => ({ applicationId: row.id, reason: 'same_company_title' }));
  if (!opportunityId) {
    opportunityId = randomUUID();
    await context.transaction.query(`INSERT INTO career.opportunities(id,owner_id,company,title,platform,tenant,job_code,job_key,kind,seniority,modality,description,stack)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [opportunityId, context.ownerId, input.company, input.title, input.platform, input.tenant, input.jobCode, input.jobKey, input.kind, input.seniority, input.modality, input.description, input.stack]);
  }
  for (const identity of identities) {
    const evidenceId = identity.verificationEvidence ? await resolveEvidence(context, identity.verificationEvidence) : null;
    await context.transaction.query(`INSERT INTO career.opportunity_identities(owner_id,opportunity_id,provider,tenant,identity_kind,identity_value,verification_evidence_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,normalized_provider,normalized_tenant,identity_kind,normalized_value) DO NOTHING`, [context.ownerId, opportunityId, identity.provider, identity.tenant, identity.kind, identity.value, evidenceId]);
  }
  const id = randomUUID();
  await context.transaction.query(`INSERT INTO career.applications(id,owner_id,opportunity_id,track,application_instance,submission_status,submitted_date,stage,cycle_relation,discovery_channel,submission_platform,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, context.ownerId, opportunityId, data.track, data.applicationInstance, data.submissionStatus, data.submittedDate, data.stage, data.cycleRelation, data.discoveryChannel, data.submissionPlatform, data.notes]);
  await appendLinks(context, id, data.links); await selectResumes(context, id, data.resumeIds);
  const evidenceId = command.evidence ? await resolveEvidence(context, command.evidence) : null;
  if (data.submissionStatus === 'confirmado') await event(context, id, 'envio_confirmado', evidenceId, data.submittedDate);
  else if (evidenceId) await event(context, id, 'nota', evidenceId, unknownDate);
  if (data.stage !== 'desconhecida') await appendStageEvent(context, id, data.stage, evidenceId);
  await mapCreation(context, 'application', command.clientId, command, id);
  await allocateApplication(context, id);
  if (!identities.length) result.warnings.push({ applicationId: id, reason: 'unresolved_identity' });
  return { status: 201, body: await projectionResult(context, id, result) };
}

async function updateApplication(context: MutationContext, command: Extract<Command, { operation: 'update_application' }>) {
  const opportunityRefs: AggregateRef[] = command.opportunityPatch ? [{ table: 'opportunities', id: command.opportunityPatch.opportunity.id }] : [];
  const needsAllocation = command.reconciliation?.cycleRelation === 'after_reset' && eligible(await applicationRow(context, command.application.id))
    && !(await context.transaction.query('SELECT id FROM career.batch_members WHERE owner_id=$1 AND application_id=$2', [context.ownerId, command.application.id])).rowCount;
  const plan = needsAllocation ? await allocationPlan(context) : undefined;
  const affected = command.reconciliation ? await lockAffected(context, [command.application], command.affectedBatches, [...opportunityRefs, ...(plan ? allocationRefs(plan) : [])]) : null;
  if (!affected) await context.lockAggregates([{ table: 'applications', id: command.application.id }, ...opportunityRefs]);
  const current = affected?.applications[0] ?? await applicationRow(context, command.application.id); checkVersion(current, command.application);
  if (current.canonical_application_id) throw new SafeError('CONFLICT');
  if (command.opportunityPatch) {
    const patch = command.opportunityPatch;
    if (patch.opportunity.id !== current.opportunity_id) throw new SafeError('NOT_FOUND');
    const row = (await context.transaction.query<{ version: number }>('SELECT version FROM career.opportunities WHERE owner_id=$1 AND id=$2', [context.ownerId, current.opportunity_id])).rows[0]!;
    checkVersion(row, patch.opportunity);
    const columns = { company: 'company', title: 'title', kind: 'kind', seniority: 'seniority', modality: 'modality', description: 'description', stack: 'stack' } as const;
    const entries = Object.entries(patch.changes) as [keyof typeof columns, unknown][];
    await context.transaction.query(`UPDATE career.opportunities SET ${entries.map(([key], i) => `${columns[key]}=$${i + 3}`).join(',')},version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2`, [context.ownerId, current.opportunity_id, ...entries.map(([, value]) => value)]);
  }
  const columns = { track: 'track', applicationInstance: 'application_instance', stage: 'stage', discoveryChannel: 'discovery_channel', submissionPlatform: 'submission_platform', notes: 'notes' } as const;
  const entries = Object.entries(command.changes).filter(([key]) => key in columns) as [keyof typeof columns, unknown][];
  await context.transaction.query(`UPDATE career.applications SET ${entries.map(([key], i) => `${columns[key]}=$${i + 3},`).join('')}version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2`, [context.ownerId, current.id, ...entries.map(([, value]) => value)]);
  if (command.changes.resumeIds) await selectResumes(context, current.id, command.changes.resumeIds);
  if (command.changes.links) await appendLinks(context, current.id, command.changes.links);
  if (command.changes.stage !== undefined && command.changes.stage !== current.stage) await appendStageEvent(context, current.id, command.changes.stage, command.evidence ? await resolveEvidence(context, command.evidence) : null);
  const result = emptyResult();
  if (command.reconciliation && affected) {
    const correction = command.reconciliation;
    await context.transaction.query('UPDATE career.applications SET submitted_date=$3,cycle_relation=$4 WHERE owner_id=$1 AND id=$2', [context.ownerId, current.id, correction.submittedDate, correction.cycleRelation]);
    await event(context, current.id, 'correcao', await resolveEvidence(context, command.evidence!), correction.submittedDate, 'Reconciliação explícita de data e relação com o ciclo.');
    result.eligibilityChanges = [{ applicationId: current.id, before: eligible(current), after: eligible(current) }];
    result.affectedBatches = await rectifyBatches(context, affected, new Map([[current.id, eligible(current) && correction.cycleRelation === 'after_reset']]));
  } else if (command.evidence) await event(context, current.id, 'nota', await resolveEvidence(context, command.evidence), unknownDate);
  if (plan) await allocateApplication(context, current.id, plan);
  return { status: 200, body: await projectionResult(context, current.id, result) };
}

type Membership = { id: string; application_id: string; batch_id: string; cycle_id: string; version: number };
type Batch = { id: string; version: number; status: string; rectification_pending: boolean };
async function lockAffected(context: MutationContext, applicationRefs: Ref[], expected: Ref[], additionalRefs: AggregateRef[] = []) {
  const ids = applicationRefs.map((ref) => ref.id);
  const discover = async () => (await context.transaction.query<Membership>(`SELECT DISTINCT m.id,m.application_id,m.batch_id,b.cycle_id,m.version FROM career.batch_members m JOIN career.batches b ON b.owner_id=m.owner_id AND b.id=m.batch_id WHERE m.owner_id=$1 AND m.application_id=ANY($2::uuid[]) ORDER BY m.batch_id,m.id`, [context.ownerId, ids])).rows;
  const memberships = await discover();
  if (canonicalRequestHash([...new Set(memberships.map((m) => m.batch_id))].sort()) !== canonicalRequestHash(expected.map((ref) => ref.id).sort())) throw new SafeError('CONFLICT');
  const references = [
    ...ids.map((id) => ({ table: 'applications' as const, id })),
    ...memberships.map((m) => ({ table: 'batches' as const, id: m.batch_id })),
    ...memberships.map((m) => ({ table: 'cycles' as const, id: m.cycle_id })),
    ...additionalRefs,
  ];
  await context.lockAggregates([...new Map(references.map((ref) => [`${ref.table}:${ref.id}`, ref])).values()]);
  if (canonicalRequestHash(await discover()) !== canonicalRequestHash(memberships)) throw new SafeError('CONFLICT');
  const applications = await Promise.all(applicationRefs.map((ref) => applicationRow(context, ref.id)));
  applications.forEach((row, i) => checkVersion(row, applicationRefs[i]!));
  const batches = (await context.transaction.query<Batch>('SELECT id,version,status,rectification_pending FROM career.batches WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id', [context.ownerId, memberships.map((m) => m.batch_id)])).rows;
  batches.forEach((row) => checkVersion(row, expected.find((ref) => ref.id === row.id)!));
  return { applications, batches, memberships };
}
async function rectifyBatches(context: MutationContext, affected: Awaited<ReturnType<typeof lockAffected>>, desired: Map<string, boolean>) {
  const results: ApplicationResult['affectedBatches'] = [];
  for (const batch of affected.batches) {
    const members = affected.memberships.filter((member) => member.batch_id === batch.id && desired.has(member.application_id));
    if (!members.length) continue;
    if (batch.status !== 'closed') {
      for (const member of members) await context.transaction.query('UPDATE career.batch_members SET eligible=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND eligible IS DISTINCT FROM $3', [context.ownerId, member.id, desired.get(member.application_id)]);
    }
    await context.transaction.query(`UPDATE career.batches b SET rectification_pending=rectification_pending OR status='closed',
      status=CASE WHEN status='closed' THEN status WHEN (SELECT count(*) FROM career.batch_members m WHERE m.owner_id=b.owner_id AND m.batch_id=b.id AND m.eligible AND m.allocation='counted')>=target THEN 'pending' ELSE 'open' END,
      version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2`, [context.ownerId, batch.id]);
    results.push({ id: batch.id, version: batch.version + 1, rectificationPending: batch.rectification_pending || batch.status === 'closed' });
  }
  return results;
}
async function correct(context: MutationContext, command: Extract<Command, { operation: 'resolve_duplicate' | 'invalidate_submission' }>) {
  const affected = await lockAffected(context, [command.application, ...(command.operation === 'resolve_duplicate' ? [command.canonicalApplication] : [])], command.affectedBatches);
  const rows = affected.applications;
  const source = rows[0]!; const target = rows[1];
  if (source.canonical_application_id || target?.canonical_application_id || target?.id === source.id) throw new SafeError('CONFLICT');
  if (target && (source.normalized_track !== target.normalized_track || source.application_instance !== target.application_instance)) throw new SafeError('CONFLICT');
  const evidenceId = await resolveEvidence(context, command.evidence);
  await context.transaction.query('UPDATE career.applications SET counting_eligible=false,canonical_application_id=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [context.ownerId, source.id, target?.id ?? null]);
  if (target) await context.transaction.query('UPDATE career.applications SET version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [context.ownerId, target.id]);
  await event(context, source.id, 'correcao', evidenceId, unknownDate, command.reason);
  const result = emptyResult();
  result.eligibilityChanges = rows.map((row) => ({ applicationId: row.id, before: eligible(row), after: row.id === source.id ? false : eligible(row) }));
  result.affectedBatches = await rectifyBatches(context, affected, new Map([[source.id, false]]));
  return { status: 200, body: await projectionResult(context, target?.id ?? source.id, result) };
}

/** Serviços de domínio; nenhum arquivo, URL ou token é lido por estas operações. */
export function createApplicationService(database: ReturnType<typeof createDatabase>) {
  return createMutation(database, { operation: 'application_command', commandSchema, responseSchema: applicationResultSchema,
    async execute(context, command) {
      await domainLock(context);
      try {
        if (command.operation === 'save_application') return await saveApplication(context, command);
        if (command.operation === 'create_resume_ref') {
          const prior = await priorCreation(context, 'resume_ref', command.clientId, command);
          const id = prior ?? randomUUID(); const data = command.data;
          if (!prior) {
            await context.transaction.query('INSERT INTO career.resume_refs(id,owner_id,label,stack,language,local_ref) VALUES($1,$2,$3,$4,$5,$6)', [id, context.ownerId, data.label, data.stack, data.language, data.localRef]);
            await mapCreation(context, 'resume_ref', command.clientId, command, id);
          }
          const body = emptyResult(); body.existing = Boolean(prior); body.resumeRef = (await listResumeRefs(context.transaction, context.ownerId)).find((row) => row.id === id)!;
          return { status: prior ? 200 : 201, body };
        }
        if (command.operation === 'update_application') return await updateApplication(context, command);
        if (command.operation === 'resolve_duplicate' || command.operation === 'invalidate_submission') return await correct(context, command);
        if (command.operation === 'confirm_submission' || command.operation === 'archive_application' || command.operation === 'restore_application') {
          await context.lockAggregates([{ table: 'applications', id: command.application.id }]);
          const row = await applicationRow(context, command.application.id); checkVersion(row, command.application);
          if (row.canonical_application_id) throw new SafeError('CONFLICT');
          if (command.operation === 'confirm_submission') {
            const evidenceId = await resolveEvidence(context, command.evidence);
            if (row.submission_status === 'confirmado') {
              await event(context, row.id, 'nota', evidenceId, unknownDate);
              await context.transaction.query('UPDATE career.applications SET version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [context.ownerId, row.id]);
            } else {
              await context.transaction.query("UPDATE career.applications SET submission_status='confirmado',submitted_date=$3,cycle_relation=$4,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [context.ownerId, row.id, command.submittedDate, command.cycleRelation]);
              await event(context, row.id, 'envio_confirmado', evidenceId, command.submittedDate);
            }
          } else if (command.operation === 'archive_application' ? row.archived_at === null : row.archived_at !== null) {
            await context.transaction.query(`UPDATE career.applications SET archived_at=${command.operation === 'archive_application' ? 'now()' : 'NULL'},version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2`, [context.ownerId, row.id]);
          }
          if (command.operation === 'confirm_submission') await allocateApplication(context, row.id);
          return { status: 200, body: await projectionResult(context, row.id) };
        }
        throw new SafeError('INVALID_INPUT');
      } catch (error) {
        // O callback termina: nunca continuar SQL após uma violação de unicidade.
        if ((error as { code?: string }).code === '23505') throw new SafeError('CONFLICT');
        throw error;
      }
    },
  });
}
