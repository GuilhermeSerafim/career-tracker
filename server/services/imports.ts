import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { manifestSchema } from '../../scripts/import-legacy.js';
import { compareLegacyRows, IMPORTER_VERSION, LEGACY_HEADER, parseLegacyCsv, projectLegacySourceAttribution, sha256, type LegacyRow } from '../../domain/import.js';
import { MAX_SOURCE_ARCHIVE_BYTES, reviewSnapshotSchema } from '../../shared/transfer.js';
import { cycleRelationSchema, dateValueSchema, eventFields, instantSchema, linkDataSchema, positiveVersionSchema, shortTextSchema, uuidSchema, type DateValue } from '../../shared/model.js';
import { normalizeTrack } from '../../domain/identity.js';
import { SafeError, safeError } from '../errors.js';
import { assertAuthenticatedOwner, type AuthenticatedOwner } from '../auth.js';
import { createRequestContext, type AuthenticatedTransaction, type createDatabase } from '../database.js';
import { loadAppliedImportStates, loadImportBasis } from '../repositories/transfers.js';
import { lockApplicationIdentity, resolveOpportunityIdentity } from '../repositories/identities.js';
import { canonicalRequestHash } from '../mutation.js';
import { assertRepresentableJson } from '../input.js';

const unknownDate = { precision: 'unknown', value: null };
const refSchema = z.strictObject({ runId: uuidSchema });
const cycleSchema = z.strictObject({ id: uuidSchema, expectedVersion: positiveVersionSchema.nullable(), resetDate: dateValueSchema, resetMarker: z.string().max(200).nullable(), isCurrent: z.boolean() });
export const importPrepareSchema = z.strictObject({ manifest: manifestSchema, sources: z.array(z.strictObject({ name: z.string().max(4096), bytesBase64: z.string().max(Math.ceil(MAX_SOURCE_ARCHIVE_BYTES / 3) * 4) })).min(1).max(100), cycle: cycleSchema });
const interpretationSchema = z.strictObject({ track: z.string().max(200).nullable(), applicationInstance: z.string().trim().min(1).max(200), cycleRelation: cycleRelationSchema, kind: z.enum(['vaga', 'banco_talentos', 'pipeline', 'desconhecido']), provider: z.string().trim().min(1).max(200).nullable(), tenant: z.string().trim().min(1).max(200).nullable() })
  .refine((v) => (v.provider === null) === (v.tenant === null));
const decisionsSchema = z.strictObject(Object.fromEntries(LEGACY_HEADER.map((key) => [key, z.enum(['source', 'current'])])) as Record<typeof LEGACY_HEADER[number], z.ZodEnum<{ source: 'source'; current: 'current' }>>);
const historicalEventSchema = z.strictObject({ clientId: uuidSchema, ...eventFields }).refine((v) => v.kind !== 'envio_confirmado');
const applicationSchema = refSchema.extend({ legacyId: z.string().regex(/^V\d+$/).max(200), expectedVersion: positiveVersionSchema.nullable(), expectedOpportunityVersion: positiveVersionSchema.nullable(), interpretation: interpretationSchema, decisions: decisionsSchema.nullable(), historicalEvents: z.array(historicalEventSchema).max(100).default([]), affectedBatches: z.array(z.strictObject({ id: uuidSchema, expectedVersion: positiveVersionSchema })).max(100).default([]) }).refine((v) => new Set(v.historicalEvents.map((e) => e.clientId)).size === v.historicalEvents.length && new Set(v.affectedBatches.map((b) => b.id)).size === v.affectedBatches.length);
const reviewSchema = refSchema.extend({
  batchNumber: z.number().int().positive().max(2_147_483_647), members: z.array(z.strictObject({ legacyId: z.string().regex(/^V\d+$/).max(200), capturedOrder: z.number().int().positive().safe(), expectedVersion: positiveVersionSchema })).length(30),
  markdownFile: z.string().max(4096).regex(/\.md$/i), closedAt: instantSchema.nullable(), historicalClosedDate: dateValueSchema, documentedUpdatedDate: dateValueSchema, snapshotTimeMeaning: z.enum(['import_capture', 'historical_instant']), snapshot: reviewSnapshotSchema,
  pendingIssues: z.array(z.string().max(50_000)).max(100),
}).refine((v) => new Set(v.members.map((m) => m.legacyId)).size === 30 && new Set(v.members.map((m) => m.capturedOrder)).size === 30);
type ApplicationInput = z.infer<typeof applicationSchema>;
interface UnitResult { applicationId: string; version: number; result: 'imported' | 'skipped' }
interface ReviewResult { reviewId: string; batchId: string }
interface Run { id: string; unit_state: { cycleId: string; cycleConfig: Omit<z.infer<typeof cycleSchema>, 'expectedVersion'>; review?: { requestHash: string; result: ReviewResult }; completed?: { reviewRequired: boolean; runId: string; rowCount: number } }; status: string }
async function runRow(tx: AuthenticatedTransaction, owner: string, runId: string): Promise<Run> {
  const run = (await tx.query<Run>('SELECT id,unit_state,status FROM career.import_runs WHERE owner_id=$1 AND id=$2', [owner, runId])).rows[0];
  if (!run) throw new SafeError('NOT_FOUND'); return run;
}
async function readCsv(tx: AuthenticatedTransaction, owner: string, runId: string) {
  const file = (await tx.query<{ id: string; original_bytes: Buffer; file_hash: string }>("SELECT id,original_bytes,file_hash FROM career.source_files WHERE owner_id=$1 AND import_run_id=$2 AND file_name ~* '\\.csv$'", [owner, runId])).rows[0];
  if (!file || sha256(file.original_bytes) !== file.file_hash) throw new SafeError('INVALID_INPUT');
  const parsed = parseLegacyCsv(file.original_bytes); if (parsed.blocked) throw new SafeError('INVALID_INPUT');
  return { ...file, parsed };
}

/** Cada chamada confirma uma única unidade lógica. Nenhum caminho do cliente é aberto. */
export function createImportService(database: ReturnType<typeof createDatabase>) {
  async function unit<Input, Output>(actor: AuthenticatedOwner, raw: unknown, schema: z.ZodType<Input>, execute: (tx: AuthenticatedTransaction, data: Input) => Promise<Output>, transaction?: AuthenticatedTransaction) {
    const request = createRequestContext();
    try {
      assertAuthenticatedOwner(actor, actor.ownerId);
      if (actor.actorKind !== 'owner') throw new SafeError('FORBIDDEN');
      const parsed = schema.safeParse(raw); if (!parsed.success) throw new SafeError('INVALID_INPUT');
      const run = async (tx: AuthenticatedTransaction) => {
        await lockApplicationIdentity(tx, actor.ownerId);
        // Derivado da sessão humana autenticada e do serviço; nunca aceito no corpo.
        await tx.query("SELECT set_config('app.actor_kind','import',true),set_config('app.actor_id',$1,true),set_config('app.source',$2,true)", [actor.ownerId, IMPORTER_VERSION]);
        return execute(tx, parsed.data);
      };
      return await (transaction ? run(transaction) : database.transaction(actor, run, request));
    } catch (error) {
      if (['23505', '23514'].includes((error as { code?: string }).code ?? '')) throw new SafeError('CONFLICT', { requestId: request.requestId });
      throw safeError(error, request.requestId);
    }
  }
  const prepare = (actor: AuthenticatedOwner, raw: unknown, transaction?: AuthenticatedTransaction) => unit(actor, raw, importPrepareSchema, async (tx, input) => {
    const { manifest } = input;
    if (manifest.parsed.blocked || input.sources.length !== manifest.sources.length) throw new SafeError('INVALID_INPUT');
    let size = 0; const verified = [];
    for (const source of manifest.sources) {
      const uploads = input.sources.filter((v) => v.name === source.name);
      if (uploads.length !== 1) throw new SafeError('INVALID_INPUT');
      const encoded = uploads[0]!.bytesBase64; const bytes = Buffer.from(encoded, 'base64'); size += bytes.length;
      if (size > MAX_SOURCE_ARCHIVE_BYTES || bytes.toString('base64') !== encoded || bytes.length !== source.size || sha256(bytes) !== source.sha256) throw new SafeError('INVALID_INPUT');
      if (/\.csv$/i.test(source.name) && !isDeepStrictEqual(parseLegacyCsv(bytes), manifest.parsed)) throw new SafeError('INVALID_INPUT');
      let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new SafeError('INVALID_INPUT'); }
      assertRepresentableJson(text);
      verified.push({ name: source.name, bytes, text, hash: sha256(bytes) });
    }
    const old = (await tx.query<Run>('SELECT id,unit_state,status FROM career.import_runs WHERE owner_id=$1 AND source_set_hash=$2 AND importer_version=$3', [actor.ownerId, manifest.sourceSetHash, IMPORTER_VERSION])).rows[0];
    const cycleConfig = { id: input.cycle.id, resetDate: input.cycle.resetDate, resetMarker: input.cycle.resetMarker, isCurrent: input.cycle.isCurrent };
    if (old) {
      if (!isDeepStrictEqual(old.unit_state.cycleConfig, cycleConfig)) throw new SafeError('IDEMPOTENCY_CONFLICT');
      return { runId: old.id, cycleId: old.unit_state.cycleId };
    }
    const cycle = input.cycle;
    const existingCycle = (await tx.query<{ version: number; reset_date: unknown; reset_marker: string | null; is_current: boolean }>('SELECT version,reset_date,reset_marker,is_current FROM career.cycles WHERE owner_id=$1 AND id=$2 FOR UPDATE', [actor.ownerId, cycle.id])).rows[0];
    if (existingCycle) {
      if (existingCycle.version !== cycle.expectedVersion || existingCycle.is_current !== cycle.isCurrent || !isDeepStrictEqual(existingCycle.reset_date, cycle.resetDate) || existingCycle.reset_marker !== cycle.resetMarker) throw new SafeError('CONFLICT');
    } else {
      if (cycle.expectedVersion !== null) throw new SafeError('CONFLICT');
      await tx.query('INSERT INTO career.cycles(id,owner_id,reset_date,reset_marker,is_current,next_order) SELECT $1,$2,$3,$4,$5,coalesce(max(cycle_order),0)+1 FROM career.applications WHERE owner_id=$2', [cycle.id, actor.ownerId, cycle.resetDate, cycle.resetMarker, cycle.isCurrent]);
    }
    const runId = randomUUID();
    await tx.query("INSERT INTO career.import_runs(id,owner_id,importer_version,source_set_hash,status,pending_issues,unit_state) VALUES($1,$2,$3,$4,'running',$5,$6)", [runId, actor.ownerId, IMPORTER_VERSION, manifest.sourceSetHash, [...new Set(manifest.parsed.issues.map((issue) => issue.code))], { cycleId: cycle.id, cycleConfig }]);
    for (const file of verified) await tx.query('INSERT INTO career.source_files(owner_id,import_run_id,file_name,file_hash,original_bytes,original_text) VALUES($1,$2,$3,$4,$5,$6)', [actor.ownerId, runId, file.name, file.hash, file.bytes, file.text]);
    return { runId, cycleId: cycle.id };
  }, transaction);
  const preview = (actor: AuthenticatedOwner, raw: unknown, transaction?: AuthenticatedTransaction) => unit(actor, raw, refSchema, async (tx, input) => {
    await runRow(tx, actor.ownerId, input.runId); const file = await readCsv(tx, actor.ownerId, input.runId);
    return { diff: compareLegacyRows(file.parsed.rows, await loadImportBasis(tx, actor.ownerId)) };
  }, transaction);
  const applyApplication = (actor: AuthenticatedOwner, raw: unknown, transaction?: AuthenticatedTransaction) => unit(actor, raw, applicationSchema, async (tx, input): Promise<UnitResult> => {
    const run = await runRow(tx, actor.ownerId, input.runId); const file = await readCsv(tx, actor.ownerId, input.runId);
    const index = file.parsed.rows.findIndex((v) => v.legacyId === input.legacyId); const row = file.parsed.rows[index]; if (!row) throw new SafeError('NOT_FOUND');
    const previousUnit = (await tx.query<{ unit_result: UnitResult; resolution: { request: ApplicationInput } }>('SELECT unit_result,resolution FROM career.import_rows WHERE owner_id=$1 AND source_file_id=$2 AND row_number=$3', [actor.ownerId, file.id, index + 2])).rows[0];
    if (previousUnit) {
      if (!isDeepStrictEqual(previousUnit.resolution.request, input)) throw new SafeError('IDEMPOTENCY_CONFLICT'); return previousUnit.unit_result;
    }
    const prior = (await loadAppliedImportStates(tx, actor.ownerId)).find((v) => v.legacyId === input.legacyId);
    const basis = prior;
    if (run.status === 'completed') throw new SafeError('CONFLICT');
    const existing = (await tx.query<{ id: string; version: number; opportunity_id: string; cycle_order: string | null; submission_status: string; track: string | null; application_instance: string; cycle_relation: string; canonical_application_id: string | null }>('SELECT id,version,opportunity_id,cycle_order,submission_status,track,application_instance,cycle_relation,canonical_application_id FROM career.applications WHERE owner_id=$1 AND legacy_id=$2 FOR UPDATE', [actor.ownerId, row.legacyId])).rows[0];
    const sourceChanged = !basis || basis.rawRowHash !== row.rawRowHash;
    let result: UnitResult; let baseline: number;
    if (existing && !basis) throw new SafeError('CONFLICT');
    if (existing && !sourceChanged && input.decisions === null) {
      result = { applicationId: existing.id, version: existing.version, result: 'skipped' }; baseline = basis!.importedApplicationVersion;
    } else if (existing) {
      if (existing.canonical_application_id !== null) throw new SafeError('CONFLICT');
      if (input.expectedVersion !== existing.version || !input.decisions) throw new SafeError('CONFLICT');
      const opportunity = (await tx.query<{ version: number }>('SELECT version FROM career.opportunities WHERE owner_id=$1 AND id=$2 FOR UPDATE', [actor.ownerId, existing.opportunity_id])).rows[0]!;
      if (input.expectedOpportunityVersion !== opportunity.version) throw new SafeError('CONFLICT');
      if (input.decisions.ordem_ciclo === 'source' && row.cycleOrder !== (existing.cycle_order === null ? null : Number(existing.cycle_order))) throw new SafeError('CONFLICT');
      if (input.interpretation.track !== existing.track || input.interpretation.applicationInstance !== existing.application_instance || input.interpretation.cycleRelation !== existing.cycle_relation) throw new SafeError('CONFLICT');
      const priorRow = parseLegacyCsv(LEGACY_HEADER.join(',') + '\n' + prior!.originalText).rows[0]!;
      if (['provider', 'tenant', 'kind'].some((key) => prior!.resolution.appliedInterpretation[key as 'provider' | 'tenant' | 'kind'] !== input.interpretation[key as 'provider' | 'tenant' | 'kind'])) throw new SafeError('CONFLICT');
      // Alterações de chave forte exigem resolver identidade explicitamente; não fingir aplicação.
      for (const field of ['plataforma', 'codigo_vaga', 'chave_vaga'] as const) if (input.decisions[field] === 'source' && row.fields[field] !== priorRow.fields[field]) throw new SafeError('CONFLICT');
      const affectsPopulation = input.decisions.status_envio === 'source' || input.decisions.data_envio === 'source';
      const batches = affectsPopulation ? (await tx.query<{ id: string; version: number; status: string }>('SELECT id,version,status FROM career.batches WHERE owner_id=$1 AND id IN (SELECT batch_id FROM career.batch_members WHERE owner_id=$1 AND application_id=$2) ORDER BY id FOR UPDATE', [actor.ownerId, existing.id])).rows : [];
      if (!isDeepStrictEqual(batches.map((b) => b.id).sort(), input.affectedBatches.map((b) => b.id).sort()) || batches.some((b) => input.affectedBatches.find((v) => v.id === b.id)?.expectedVersion !== b.version)) throw new SafeError('CONFLICT');
      await updateSourceFields(tx, actor.ownerId, existing, row, input);
      for (const batch of batches) {
        if (batch.status !== 'closed') await tx.query(`UPDATE career.batch_members m SET eligible=(a.submission_status='confirmado' AND a.counting_eligible AND a.canonical_application_id IS NULL AND a.cycle_relation='after_reset'),version=m.version+1,updated_at=now()
          FROM career.applications a WHERE a.owner_id=m.owner_id AND a.id=m.application_id AND m.owner_id=$1 AND m.batch_id=$2 AND m.application_id=$3`, [actor.ownerId, batch.id, existing.id]);
        await tx.query(`UPDATE career.batches b SET rectification_pending=rectification_pending OR status='closed',status=CASE WHEN status='closed' THEN status WHEN (SELECT count(*) FROM career.batch_members m WHERE m.owner_id=b.owner_id AND m.batch_id=b.id AND m.eligible AND m.allocation='counted')>=target THEN 'pending' ELSE 'open' END,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2`, [actor.ownerId, batch.id]);
      }
      result = { applicationId: existing.id, version: existing.version + 1, result: 'imported' }; baseline = result.version;
    } else {
      if (input.expectedVersion !== null || input.expectedOpportunityVersion !== null || input.decisions !== null) throw new SafeError('CONFLICT');
      result = await insertApplication(tx, actor.ownerId, row, input); baseline = result.version;
    }
    let evidenceId: string | null = null;
    const projectableLinks = row.links.filter((link) => ['web', 'private', 'local'].includes(link.classification) && link.originalText.trim() !== '' && linkDataSchema.safeParse({ originalUrl: link.originalText, comparisonUrl: null, kind: 'legado', isLocal: link.classification === 'local', isPrivate: link.classification !== 'web' }).success);
    const pendingIssues = file.parsed.issues.filter((v) => v.row === index + 2).map((v) => v.code);
    if (!input.interpretation.provider || !row.jobCode.trim()) pendingIssues.push('unresolved_identity');
    if (projectableLinks.length !== row.links.length) pendingIssues.push('unprojected_reference');
    if (result.result === 'imported') {
      const confirms = (!existing || existing.submission_status !== 'confirmado' && input.decisions?.status_envio === 'source') && row.submissionStatus === 'confirmado';
      const links = projectableLinks.filter((link) => !existing || (link.originalText === row.fields.url_original ? input.decisions?.url_original : input.decisions?.links_alternativos) === 'source');
      const { source, warning } = projectLegacySourceAttribution(row.source, input.decisions?.fonte);
      if (warning) pendingIssues.push(warning);
      evidenceId = await appendSourceEvidence(tx, actor.ownerId, result.applicationId, { ...row, links }, confirms, input.decisions, source);
    }
    for (const event of input.historicalEvents) await appendHistoricalEvent(tx, actor.ownerId, result.applicationId, event, evidenceId);
    await tx.query(`INSERT INTO career.import_rows(owner_id,source_file_id,row_number,row_hash,original_text,legacy_id,target_application_id,result,pending_issues,applied_target_version,resolution,unit_result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [actor.ownerId, file.id, index + 2, row.rawRowHash, row.raw, row.legacyId, result.applicationId, result.result, pendingIssues, baseline, { request: input, appliedInterpretation: result.result === 'skipped' ? prior!.resolution.appliedInterpretation : input.interpretation }, result]);
    const retainedOrder = existing ? (existing.cycle_order === null ? null : Number(existing.cycle_order)) : row.cycleOrder;
    if (retainedOrder !== null) await tx.query('UPDATE career.cycles SET next_order=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND next_order<$3', [actor.ownerId, run.unit_state.cycleId, retainedOrder + 1]);
    return result;
  }, transaction);
  const applyReview = (actor: AuthenticatedOwner, raw: unknown, transaction?: AuthenticatedTransaction) => unit(actor, raw, reviewSchema, async (tx, input): Promise<ReviewResult> => {
    const run = await runRow(tx, actor.ownerId, input.runId); const requestHash = canonicalRequestHash(input);
    if (run.unit_state.review) {
      if (run.unit_state.review.requestHash !== requestHash) throw new SafeError('IDEMPOTENCY_CONFLICT'); return run.unit_state.review.result;
    }
    if (run.status === 'completed') throw new SafeError('CONFLICT');
    const file = (await tx.query<{ id: string; file_hash: string; original_bytes: Buffer }>('SELECT id,file_hash,original_bytes FROM career.source_files WHERE owner_id=$1 AND import_run_id=$2 AND file_name=$3', [actor.ownerId, input.runId, input.markdownFile])).rows[0];
    if (!file || sha256(file.original_bytes) !== file.file_hash) throw new SafeError('NOT_FOUND');
    // O arquivo fonte continua completo. A projeção de revisão precisa caber no
    // contrato de texto/auditoria já recuperável, sem produzir histórico inválido.
    if (file.original_bytes.toString('utf8').length > 50_000) throw new SafeError('PAYLOAD_TOO_LARGE');
    const applications = (await tx.query<{ id: string; legacy_id: string; version: number; cycle_order: string | null }>('SELECT id,legacy_id,version,cycle_order FROM career.applications WHERE owner_id=$1 AND legacy_id=ANY($2::text[]) ORDER BY id FOR UPDATE', [actor.ownerId, input.members.map((m) => m.legacyId)])).rows;
    if (applications.length !== 30) throw new SafeError('NOT_FOUND');
    const populationIds = input.members.map((member) => {
      const app = applications.find((a) => a.legacy_id === member.legacyId)!;
      if (app.version !== member.expectedVersion || Number(app.cycle_order) !== member.capturedOrder) throw new SafeError('CONFLICT'); return app.id;
    });
    if (!isDeepStrictEqual(input.snapshot.populationIds, populationIds) || (input.closedAt === null ? input.snapshotTimeMeaning !== 'import_capture' : input.snapshotTimeMeaning !== 'historical_instant' || input.snapshot.asOf !== input.closedAt)) throw new SafeError('INVALID_INPUT');
    const outside = input.snapshot.externalResultApplicationIds ?? [];
    if (outside.some((id) => populationIds.includes(id)) || new Set(outside).size !== outside.length) throw new SafeError('INVALID_INPUT');
    const external = await tx.query('SELECT id FROM career.applications WHERE owner_id=$1 AND id=ANY($2::uuid[])', [actor.ownerId, outside]);
    if (external.rowCount !== outside.length) throw new SafeError('NOT_FOUND');
    const eventIds = input.snapshot.eventIds; const externalEvents = input.snapshot.externalResultEventIds ?? [];
    if (!isDeepStrictEqual([...new Set(eventIds)], eventIds) || externalEvents.some((id) => eventIds.includes(id))) throw new SafeError('INVALID_INPUT');
    for (const [ids, targets] of [[eventIds, populationIds], [externalEvents, outside]]) {
      const events = await tx.query('SELECT id FROM career.events WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND application_id=ANY($3::uuid[])', [actor.ownerId, ids, targets]);
      if (events.rowCount !== ids!.length) throw new SafeError('NOT_FOUND');
    }
    const batchId = randomUUID(); const reviewId = randomUUID();
    await tx.query("INSERT INTO career.batches(id,owner_id,cycle_id,batch_number,target,status) VALUES($1,$2,$3,$4,30,'open')", [batchId, actor.ownerId, run.unit_state.cycleId, input.batchNumber]);
    for (const [index, member] of input.members.entries()) await tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,$4)', [actor.ownerId, batchId, populationIds[index], member.capturedOrder]);
    const importedAt = (await tx.query<{ value: Date }>('SELECT now() AS value')).rows[0]!.value.toISOString();
    const provenance = { runId: run.id, sourceFileId: file.id, sourceHash: file.file_hash, importerVersion: IMPORTER_VERSION, historicalClosedDate: input.historicalClosedDate, documentedUpdatedDate: input.documentedUpdatedDate, snapshotTimeMeaning: input.snapshotTimeMeaning, importedAt, pendingIssues: input.pendingIssues };
    await tx.query(`INSERT INTO career.review_versions(id,owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids,narrative,original_markdown,closed_at,import_provenance)
      VALUES($1,$2,$3,1,'original',$4,$5,$6,$7,$7,$8,$9)`, [reviewId, actor.ownerId, batchId, input.snapshot, populationIds, eventIds, file.original_bytes.toString('utf8'), input.closedAt, provenance]);
    await tx.query("UPDATE career.batches SET status='closed',version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [actor.ownerId, batchId]);
    const result = { reviewId, batchId };
    await tx.query('UPDATE career.import_runs SET unit_state=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [actor.ownerId, run.id, { ...run.unit_state, review: { requestHash, result } }]);
    return result;
  }, transaction);
  const complete = (actor: AuthenticatedOwner, raw: unknown, transaction?: AuthenticatedTransaction) => unit(actor, raw, refSchema.extend({ reviewRequired: z.boolean() }), async (tx, input) => {
    const run = await runRow(tx, actor.ownerId, input.runId);
    if (run.unit_state.completed) {
      if (run.unit_state.completed.reviewRequired !== input.reviewRequired) throw new SafeError('IDEMPOTENCY_CONFLICT'); return run.unit_state.completed;
    }
    const file = await readCsv(tx, actor.ownerId, input.runId);
    const count = Number((await tx.query<{ count: string }>("SELECT count(*) FROM career.import_rows WHERE owner_id=$1 AND source_file_id=$2 AND result IN ('imported','skipped')", [actor.ownerId, file.id])).rows[0]!.count);
    if (count !== file.parsed.rows.length || input.reviewRequired && !run.unit_state.review) throw new SafeError('CONFLICT');
    const result = { reviewRequired: input.reviewRequired, runId: run.id, rowCount: count };
    await tx.query("UPDATE career.import_runs SET status='completed',unit_state=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [actor.ownerId, run.id, { ...run.unit_state, completed: result }]);
    return result;
  }, transaction);
  return { prepare, preview, applyApplication, applyReview, complete };
}

async function insertApplication(tx: AuthenticatedTransaction, owner: string, row: LegacyRow, input: ApplicationInput): Promise<UnitResult> {
  const policy = input.interpretation;
  if (![row.company, row.title, row.legacyPlatform, row.jobCode, row.jobKey].every((v) => shortTextSchema.safeParse(v).success)) throw new SafeError('INVALID_INPUT');
  const identity = policy.provider && policy.tenant && row.jobCode.trim() ? [{ provider: policy.provider, tenant: policy.tenant, kind: 'job_code', value: row.jobCode.trim() }] : [];
  let opportunityId = await resolveOpportunityIdentity(tx, owner, identity);
  if (opportunityId) {
    const existing = (await tx.query('SELECT id FROM career.applications WHERE owner_id=$1 AND opportunity_id=$2 AND normalized_track=$3 AND application_instance=$4 AND canonical_application_id IS NULL', [owner, opportunityId, normalizeTrack(policy.track), policy.applicationInstance])).rows[0];
    if (existing) throw new SafeError('CONFLICT');
  } else {
    opportunityId = randomUUID();
    await tx.query('INSERT INTO career.opportunities(id,owner_id,company,title,platform,tenant,job_code,job_key,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [opportunityId, owner, row.company || null, row.title || null, (policy.provider ?? row.legacyPlatform) || null, policy.tenant, row.jobCode || null, row.jobKey || null, policy.kind]);
  }
  const id = randomUUID();
  await tx.query(`INSERT INTO career.applications(id,owner_id,opportunity_id,legacy_id,display_id,track,application_instance,submission_status,submitted_date,stage,cycle_relation,cycle_order,notes,legacy_registered_date,legacy_resume_text)
    VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,'desconhecida',$9,$10,$11,$12,$13)`, [id, owner, opportunityId, row.legacyId, policy.track, policy.applicationInstance, row.submissionStatus, row.submittedDate, policy.cycleRelation, row.cycleOrder, row.fields.observacoes || null, row.legacyRegisteredDate, row.legacyResumeText || null]);
  return { applicationId: id, version: 1, result: 'imported' };
}
async function updateSourceFields(tx: AuthenticatedTransaction, owner: string, existing: { id: string; opportunity_id: string }, row: LegacyRow, input: ApplicationInput) {
  const decisions = input.decisions!;
  const patch: Record<string, unknown> = {};
  if (decisions.status_envio === 'source') patch.submission_status = row.submissionStatus;
  if (decisions.data_envio === 'source') patch.submitted_date = row.submittedDate;
  if (decisions.observacoes === 'source') patch.notes = row.fields.observacoes || null;
  if (decisions.registrado_em === 'source') patch.legacy_registered_date = row.legacyRegisteredDate;
  if (decisions.cv_enviado === 'source') patch.legacy_resume_text = row.legacyResumeText || null;
  const entries = Object.entries(patch);
  await tx.query(`UPDATE career.applications SET ${entries.map(([key], i) => `${key}=$${i + 3},`).join('')}version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2`, [owner, existing.id, ...entries.map(([, value]) => value)]);
  const opportunityPatch = Object.entries({ company: decisions.empresa === 'source' ? row.company || null : undefined, title: decisions.cargo === 'source' ? row.title || null : undefined }).filter(([, value]) => value !== undefined);
  if (!opportunityPatch.every(([, value]) => shortTextSchema.nullable().safeParse(value).success)) throw new SafeError('INVALID_INPUT');
  if (opportunityPatch.length) await tx.query(`UPDATE career.opportunities SET ${opportunityPatch.map(([key], i) => `${key}=$${i + 3},`).join('')}version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2`, [owner, existing.opportunity_id, ...opportunityPatch.map(([, value]) => value)]);
}
async function appendSourceEvidence(tx: AuthenticatedTransaction, owner: string, applicationId: string, row: LegacyRow, confirms: boolean, decisions: ApplicationInput['decisions'], source: string | null) {
  const currentLinks = (await tx.query<{ original_url: string }>('SELECT original_url FROM career.links WHERE owner_id=$1 AND application_id=$2', [owner, applicationId])).rows;
  if (new Set([...currentLinks.map((v) => v.original_url), ...row.links.map((v) => v.originalText)]).size > 50) throw new SafeError('INVALID_INPUT');
  const evidence = (await tx.query<{ id: string }>("INSERT INTO career.evidence(owner_id,kind,original_text,source,occurred_date) VALUES($1,'texto_legado',$2,$3,$4) RETURNING id", [owner, row.raw, source, unknownDate])).rows[0]!;
  // A confirmação usa o resultado reconciliado; a data rejeitada continua somente no original.
  const occurredDate = confirms ? (await tx.query<{ submitted_date: DateValue }>('SELECT submitted_date FROM career.applications WHERE owner_id=$1 AND id=$2', [owner, applicationId])).rows[0]!.submitted_date : unknownDate;
  await tx.query("INSERT INTO career.events(owner_id,application_id,kind,state,occurred_date,evidence_id,source_text,result_text) VALUES($1,$2,$3,'informado',$4,$5,$6,$7)", [owner, applicationId, confirms ? 'envio_confirmado' : 'nota', occurredDate, evidence.id, decisions?.evidencia_envio === 'current' ? null : row.evidence || null, decisions?.etapa === 'current' ? null : row.stageNarrative || null]);
  for (const link of row.links) await tx.query(`INSERT INTO career.links(owner_id,application_id,original_url,kind,is_local,is_private)
    SELECT $1,$2,$3,'legado',$4,$5 WHERE NOT EXISTS(SELECT 1 FROM career.links WHERE owner_id=$1 AND application_id=$2 AND original_url=$3)`, [owner, applicationId, link.originalText, link.classification === 'local', link.classification !== 'web']);
  return evidence.id;
}
async function appendHistoricalEvent(tx: AuthenticatedTransaction, owner: string, applicationId: string, event: z.infer<typeof historicalEventSchema>, evidenceId: string | null) {
  const hash = canonicalRequestHash({ operation: 'import_historical_event', applicationId, event });
  const prior = (await tx.query<{ payload_hash: string }>("SELECT payload_hash FROM career.creation_requests WHERE owner_id=$1 AND entity_type='event' AND client_id=$2", [owner, event.clientId])).rows[0];
  if (prior) { if (prior.payload_hash !== hash) throw new SafeError('IDEMPOTENCY_CONFLICT'); return; }
  if (!evidenceId) throw new SafeError('CONFLICT');
  const id = randomUUID();
  await tx.query('INSERT INTO career.events(id,owner_id,application_id,kind,state,occurred_date,result_text,score_value,score_unit,source_text,evidence_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, owner, applicationId, event.kind, event.state, event.occurredDate, event.resultText, event.scoreValue, event.scoreUnit, event.sourceText, evidenceId]);
  await tx.query("INSERT INTO career.creation_requests(owner_id,entity_type,client_id,payload_hash,result_event_id) VALUES($1,'event',$2,$3,$4)", [owner, event.clientId, hash, id]);
}
