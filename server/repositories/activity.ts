import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dateValueSchema, eventFields, instantSchema, linksSchema, positiveVersionSchema, uuidSchema } from '../../shared/model.js';
import type { Command } from '../../shared/commands';
import type { Stage, EventKind } from '../../shared/model';
import type { MutationContext } from '../mutation';
import { canonicalRequestHash } from '../mutation.js';
import type { Transaction } from '../database';
import { SafeError } from '../errors.js';
import { applicationProjection } from './career.js';

const versioned = { id: uuidSchema, version: positiveVersionSchema };
export const taskProjectionSchema = z.strictObject({ ...versioned, applicationId: uuidSchema.nullable(), contactId: uuidSchema.nullable(), title: z.string(), dueDate: dateValueSchema, completedDate: dateValueSchema, status: z.enum(['pending', 'completed', 'cancelled']) });
const eventProjectionSchema = z.strictObject({ ...versioned, applicationId: uuidSchema, ...eventFields, evidenceId: uuidSchema.nullable(), supersedesEventId: uuidSchema.nullable(), recordedAt: instantSchema });
const contactProjectionSchema = z.strictObject({ ...versioned, name: z.string().nullable(), notes: z.string().nullable(), links: linksSchema });
export const activityResultSchema = z.strictObject({ event: eventProjectionSchema.nullable(), task: taskProjectionSchema.nullable(), contact: contactProjectionSchema.nullable(), parents: z.strictObject({ application: z.strictObject(versioned).nullable(), contact: z.strictObject(versioned).nullable() }), existing: z.boolean() });
export type ActivityResult = z.infer<typeof activityResultSchema>;
export const emptyActivityResult = (): ActivityResult => ({ event: null, task: null, contact: null, parents: { application: null, contact: null }, existing: false });
const columns = { event: 'result_event_id', task: 'result_task_id', contact: 'result_contact_id', evidence: 'result_evidence_id' } as const;
export async function priorCreation(context: MutationContext, entity: keyof typeof columns, clientId: string, payload: unknown) {
  const row = (await context.transaction.query<{ payload_hash: string; result_id: string }>(`SELECT payload_hash,${columns[entity]} AS result_id FROM career.creation_requests WHERE owner_id=$1 AND entity_type=$2 AND client_id=$3`, [context.ownerId, entity, clientId])).rows[0];
  if (row && row.payload_hash !== canonicalRequestHash(payload)) throw new SafeError('IDEMPOTENCY_CONFLICT');
  return row?.result_id;
}
export async function mapCreation(context: MutationContext, entity: keyof typeof columns, clientId: string, payload: unknown, id: string) {
  await context.transaction.query(`INSERT INTO career.creation_requests(owner_id,entity_type,client_id,payload_hash,${columns[entity]}) VALUES($1,$2,$3,$4,$5)`, [context.ownerId, entity, clientId, canonicalRequestHash(payload), id]);
}
type EventData = Extract<Command, { operation: 'record_event' }>['data'];
export async function resolveActivityEvidence(context: MutationContext, input: NonNullable<EventData['evidence']>): Promise<string> {
  if ('id' in input) {
    if (!(await context.transaction.query('SELECT id FROM career.evidence WHERE owner_id=$1 AND id=$2', [context.ownerId, input.id])).rowCount) throw new SafeError('NOT_FOUND');
    return input.id;
  }
  const prior = await priorCreation(context, 'evidence', input.clientId, input); if (prior) return prior;
  const id = randomUUID();
  await context.transaction.query('INSERT INTO career.evidence(id,owner_id,kind,original_text,source,occurred_date,private_ref,local_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, context.ownerId, input.kind, input.originalText, input.source, input.occurredDate, input.privateRef, input.localRef]);
  await mapCreation(context, 'evidence', input.clientId, input, id); return id;
}
export async function insertActivityEvent(context: MutationContext, applicationId: string, data: EventData, evidenceId: string | null, supersedesId: string | null = null) {
  const id = randomUUID();
  await context.transaction.query('INSERT INTO career.events(id,owner_id,application_id,kind,state,occurred_date,result_text,score_value,score_unit,source_text,evidence_id,supersedes_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, context.ownerId, applicationId, data.kind, data.state, data.occurredDate, data.resultText, data.scoreValue, data.scoreUnit, data.sourceText, evidenceId, supersedesId]);
  return id;
}
/** A etapa explicitamente informada não fornece data de ocorrência implícita. */
export async function appendStageEvent(context: MutationContext, applicationId: string, stage: Stage, evidenceId: string | null) {
  const kind: EventKind = ({ avaliacao: 'avaliacao', entrevista: 'entrevista', proposta: 'proposta', contratacao: 'contratacao', rejeicao: 'rejeicao', desistencia: 'desistencia', processo_encerrado: 'encerramento' } as Partial<Record<Stage, EventKind>>)[stage] ?? 'etapa_alterada';
  await insertActivityEvent(context, applicationId, { kind, state: 'informado', occurredDate: { precision: 'unknown', value: null }, resultText: null, scoreValue: null, scoreUnit: null, sourceText: stage, evidence: null }, evidenceId);
}
const selectEvents = `SELECT id,version,application_id AS "applicationId",kind,state,occurred_date AS "occurredDate",result_text AS "resultText",score_value AS "scoreValue",score_unit AS "scoreUnit",source_text AS "sourceText",evidence_id AS "evidenceId",supersedes_event_id AS "supersedesEventId",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt" FROM career.events`;
function parseEvent(row: Record<string, unknown>) {
  return eventProjectionSchema.parse({ ...row, scoreValue: row.scoreValue === null ? null : Number(row.scoreValue) });
}
export async function activityEventProjection(tx: Transaction, ownerId: string, id: string) {
  const row = (await tx.query(`${selectEvents} WHERE owner_id=$1 AND id=$2`, [ownerId, id])).rows[0];
  if (!row) throw new SafeError('NOT_FOUND');
  return parseEvent(row);
}
/** Originais e substituições são preservados, inclusive o histórico de aliases. */
export async function listApplicationEvents(tx: Transaction, ownerId: string, applicationId: string) {
  const application = await applicationProjection(tx, ownerId, applicationId);
  return (await tx.query(`${selectEvents} WHERE owner_id=$1 AND application_id=ANY($2::uuid[]) ORDER BY created_at,id`, [ownerId, application.historyApplicationIds])).rows.map(parseEvent);
}
const selectTasks = `SELECT id,version,application_id AS "applicationId",contact_id AS "contactId",title,due_date AS "dueDate",completed_date AS "completedDate",status FROM career.tasks`;
export async function taskProjection(tx: Transaction, ownerId: string, id: string) {
  const row = (await tx.query(`${selectTasks} WHERE owner_id=$1 AND id=$2`, [ownerId, id])).rows[0];
  if (!row) throw new SafeError('NOT_FOUND'); return taskProjectionSchema.parse(row);
}
export async function listPendingTasks(tx: Transaction, ownerId: string) {
  return (await tx.query(`${selectTasks} WHERE owner_id=$1 AND status='pending' ORDER BY created_at,id`, [ownerId])).rows.map((row) => taskProjectionSchema.parse(row));
}
export async function contactProjection(tx: Transaction, ownerId: string, id: string) {
  const row = (await tx.query('SELECT id,version,name,notes FROM career.contacts WHERE owner_id=$1 AND id=$2', [ownerId, id])).rows[0];
  if (!row) throw new SafeError('NOT_FOUND');
  const links = (await tx.query(`SELECT original_url AS "originalUrl",comparison_url AS "comparisonUrl",kind,is_local AS "isLocal",is_private AS "isPrivate" FROM career.links WHERE owner_id=$1 AND contact_id=$2 ORDER BY created_at,id`, [ownerId, id])).rows;
  return contactProjectionSchema.parse({ ...row, links });
}
