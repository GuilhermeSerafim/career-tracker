import { randomUUID } from 'node:crypto';
import { batchState, nextStableOrder, allocationEligible } from '../../domain/cycles.js';
import type { MutationContext } from '../mutation';
import { SafeError } from '../errors.js';
import { applicationProjection } from './career.js';
import type { Transaction } from '../database';
import type { AnalyticsRow, AnalyticsEvent } from '../../shared/analytics';

/** Uma instrução MVCC: atividade concorrente não divide as projeções congeladas. */
export async function loadReviewProjection(transaction: Transaction, owner: string, batch: string) {
  const result = await transaction.query<{ projection: { asOf: string; populationIds: string[]; countedPopulationIds: string[]; rows: AnalyticsRow[]; events: AnalyticsEvent[]; eventEvidence: { eventId: string; evidence: Record<string, unknown> }[]; resumeRefs: { id: string; label: string | null; stack: string[]; language: string | null; localRef: string | null }[] } }>(`SELECT jsonb_build_object(
    'asOf',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'populationIds',coalesce((SELECT jsonb_agg(application_id ORDER BY captured_order,id) FROM career.batch_members WHERE owner_id=$1 AND batch_id=$2),'[]'::jsonb),
    'countedPopulationIds',coalesce((SELECT jsonb_agg(application_id ORDER BY captured_order,id) FROM career.batch_members WHERE owner_id=$1 AND batch_id=$2 AND eligible AND allocation='counted'),'[]'::jsonb),
    'eventEvidence',coalesce((SELECT jsonb_agg(jsonb_build_object('eventId',e.id,'evidence',jsonb_build_object('id',v.id,'kind',v.kind,'originalText',v.original_text,'source',v.source,'occurredDate',v.occurred_date,'privateRef',v.private_ref,'localRef',v.local_ref)) ORDER BY e.id) FROM career.events e JOIN career.evidence v ON v.owner_id=e.owner_id AND v.id=e.evidence_id WHERE e.owner_id=$1),'[]'::jsonb),
    'resumeRefs',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label,'stack',stack,'language',language,'localRef',local_ref) ORDER BY id) FROM career.resume_refs WHERE owner_id=$1),'[]'::jsonb),
    'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'version',a.version,'displayId',a.display_id,'submissionStatus',a.submission_status,
      'submittedDate',a.submitted_date,'countingEligible',a.counting_eligible,'canonicalApplicationId',a.canonical_application_id,'stage',a.stage,
      'archivedAt',CASE WHEN a.archived_at IS NULL THEN NULL ELSE to_char(a.archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'cycleRelation',a.cycle_relation,'cycleOrder',a.cycle_order,'stack',o.stack,'discoveryChannel',a.discovery_channel,'submissionPlatform',a.submission_platform,
      'company',o.company,'title',o.title,'seniority',o.seniority,'modality',o.modality,
      'resumeIds',ARRAY(SELECT resume_id FROM career.application_resumes r WHERE r.owner_id=a.owner_id AND r.application_id=a.id AND r.is_active ORDER BY resume_id),
      'batchIds',ARRAY(SELECT batch_id FROM career.batch_members m WHERE m.owner_id=a.owner_id AND m.application_id=a.id ORDER BY batch_id)) ORDER BY a.id)
      FROM career.applications a JOIN career.opportunities o ON o.owner_id=a.owner_id AND o.id=a.opportunity_id WHERE a.owner_id=$1),'[]'::jsonb),
    'events',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'applicationId',e.application_id,'kind',e.kind,'state',e.state,'occurredDate',e.occurred_date,
      'resultText',e.result_text,'scoreValue',e.score_value,'scoreUnit',e.score_unit,'sourceText',e.source_text,
      'recordedAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'supersedesEventId',e.supersedes_event_id) ORDER BY e.id) FROM career.events e WHERE owner_id=$1),'[]'::jsonb)) AS projection`, [owner, batch]);
  return result.rows[0]!.projection;
}

export async function getReview(transaction: Transaction, owner: string, batch: string, versionNumber: number | null = null) {
  const version = (await transaction.query('SELECT * FROM career.review_versions WHERE owner_id=$1 AND batch_id=$2 AND ($3::integer IS NULL OR version_number=$3) ORDER BY version_number DESC LIMIT 1', [owner, batch, versionNumber])).rows[0];
  if (!version) throw new SafeError('NOT_FOUND');
  const live = await loadReviewProjection(transaction, owner, batch);
  const captured = new Set(version.event_ids as string[]);
  const population = new Set(version.population_ids as string[]);
  return { version, laterResults: live.events.filter((event) => population.has(event.applicationId) && !captured.has(event.id)) };
}

export async function reviewArea(transaction: Transaction, owner: string) {
  const cycles = (await transaction.query<{ id: string; is_current: boolean }>('SELECT id,is_current FROM career.cycles WHERE owner_id=$1 ORDER BY id', [owner])).rows;
  if (!cycles.length) return { state: 'not_started' as const, cycleId: null, batches: [] };
  const current = cycles.filter((cycle) => cycle.is_current);
  if (current.length !== 1) throw new SafeError('CYCLE_CONFIGURATION');
  const batches = (await transaction.query('SELECT id,version,batch_number,status,rectification_pending FROM career.batches WHERE owner_id=$1 AND cycle_id=$2 ORDER BY batch_number', [owner, current[0]!.id])).rows;
  return { state: 'started' as const, cycleId: current[0]!.id, batches };
}

type AllocationPlan = { cycle: string; batch: string | null };
export async function allocationPlan(context: MutationContext): Promise<AllocationPlan> {
  const cycles = (await context.transaction.query<{ id: string; is_current: boolean }>('SELECT id,is_current FROM career.cycles WHERE owner_id=$1 ORDER BY id', [context.ownerId])).rows;
  if (!cycles.length) throw new SafeError('CYCLE_NOT_STARTED');
  const current = cycles.filter((cycle) => cycle.is_current);
  if (current.length !== 1) throw new SafeError('CYCLE_CONFIGURATION');
  const batch = (await context.transaction.query<{ id: string }>(`SELECT b.id FROM career.batches b WHERE b.owner_id=$1 AND b.cycle_id=$2 AND b.status<>'closed'
    AND (SELECT count(*) FROM career.batch_members m WHERE m.owner_id=b.owner_id AND m.batch_id=b.id AND m.eligible AND m.allocation='counted')<b.target ORDER BY b.batch_number LIMIT 1`, [context.ownerId, current[0]!.id])).rows[0]?.id ?? null;
  return { cycle: current[0]!.id, batch };
}
export function allocationRefs(plan: AllocationPlan) {
  return [...(plan.batch ? [{ table: 'batches' as const, id: plan.batch }] : []), { table: 'cycles' as const, id: plan.cycle }];
}
export async function allocateApplication(context: MutationContext, id: string, prepared?: AllocationPlan) {
  const row = await applicationProjection(context.transaction, context.ownerId, id);
  if (!allocationEligible(row)) return;
  const member = await context.transaction.query('SELECT id FROM career.batch_members WHERE owner_id=$1 AND application_id=$2', [context.ownerId, id]);
  if (member.rowCount) return;
  const plan = prepared ?? await allocationPlan(context);
  await context.lockAggregates([{ table: 'applications', id }, ...allocationRefs(plan)]);
  const checked = await allocationPlan(context);
  // Nunca adquirir um lote recém-descoberto depois do ciclo: recomeçar a operação.
  if (checked.cycle !== plan.cycle || checked.batch !== plan.batch) throw new SafeError('CONFLICT');
  const cycle = (await context.transaction.query<{ next_order: string }>('SELECT next_order FROM career.cycles WHERE owner_id=$1 AND id=$2', [context.ownerId, plan.cycle])).rows[0]!;
  const orders = (await context.transaction.query<{ cycle_order: string }>('SELECT cycle_order FROM career.applications WHERE owner_id=$1 AND cycle_order IS NOT NULL', [context.ownerId])).rows.map((value) => Number(value.cycle_order));
  const order = row.cycleOrder ?? nextStableOrder(Number(cycle.next_order), orders);
  let batch = plan.batch;
  if (!batch) {
    batch = randomUUID();
    await context.transaction.query(`INSERT INTO career.batches(id,owner_id,cycle_id,batch_number) SELECT $1,$2,$3,coalesce(max(batch_number),0)+1 FROM career.batches WHERE owner_id=$2 AND cycle_id=$3`, [batch, context.ownerId, plan.cycle]);
  }
  // Lote existente já está bloqueado; lote novo pertence a esta transação.
  const target = (await context.transaction.query<{ target: number }>('SELECT target FROM career.batches WHERE owner_id=$1 AND id=$2', [context.ownerId, batch])).rows[0]!.target;
  await context.transaction.query('UPDATE career.applications SET cycle_order=$3 WHERE owner_id=$1 AND id=$2', [context.ownerId, id, order]);
  await context.transaction.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,$4)', [context.ownerId, batch, id, order]);
  const count = (await context.transaction.query<{ n: number }>("SELECT count(*)::int AS n FROM career.batch_members WHERE owner_id=$1 AND batch_id=$2 AND eligible AND allocation='counted'", [context.ownerId, batch])).rows[0]!.n;
  await context.transaction.query('UPDATE career.batches SET status=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [context.ownerId, batch, batchState(count, target)]);
  await context.transaction.query('UPDATE career.cycles SET next_order=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [context.ownerId, plan.cycle, Math.max(order + 1, Number(cycle.next_order))]);
}
