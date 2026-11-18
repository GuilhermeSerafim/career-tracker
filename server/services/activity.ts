import { randomUUID } from 'node:crypto';
import { commandSchema } from '../../shared/commands.js';
import type { Command } from '../../shared/commands';
import { localDaySchema } from '../../shared/model.js';
import { normalizeJobUrl } from '../../domain/identity.js';
import { toLocalDay } from '../../domain/dates.js';
import type { createDatabase, Transaction } from '../database';
import { createMutation } from '../mutation.js';
import type { AggregateRef, MutationContext } from '../mutation';
import { SafeError } from '../errors.js';
import { activityEventProjection, activityResultSchema, contactProjection, emptyActivityResult, insertActivityEvent, listPendingTasks, mapCreation, priorCreation, resolveActivityEvidence, taskProjection } from '../repositories/activity.js';
import type { ActivityResult } from '../repositories/activity';

type Ref = { id: string; expectedVersion: number };
type Parents = Extract<Command, { operation: 'save_task' }>['parents'];
function checkVersion(row: { version: number }, ref: Ref) {
  if (row.version !== ref.expectedVersion) throw new SafeError('CONFLICT', { details: { currentVersion: row.version, changedFields: [] } });
}
async function parentRows(context: MutationContext, parents: Parents) {
  const result: ActivityResult['parents'] = { application: null, contact: null };
  for (const [key, table] of [['application', 'applications'], ['contact', 'contacts']] as const) {
    const ref = parents[key]; if (!ref) continue;
    const row = (await context.transaction.query<{ id: string; version: number }>(`SELECT id,version FROM career.${table} WHERE owner_id=$1 AND id=$2`, [context.ownerId, ref.id])).rows[0];
    if (!row) throw new SafeError('NOT_FOUND'); result[key] = row;
  }
  return result;
}
async function advanceParents(context: MutationContext, parents: Parents) {
  for (const [key, table] of [['application', 'applications'], ['contact', 'contacts']] as const) {
    if (parents[key]) await context.transaction.query(`UPDATE career.${table} SET version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2`, [context.ownerId, parents[key]!.id]);
  }
  return parentRows(context, parents);
}
async function assertWritableApplication(context: MutationContext, parents: Parents) {
  if (!parents.application) return;
  const row = (await context.transaction.query<{ canonical_application_id: string | null }>('SELECT canonical_application_id FROM career.applications WHERE owner_id=$1 AND id=$2', [context.ownerId, parents.application.id])).rows[0];
  if (!row) throw new SafeError('NOT_FOUND');
  if (row.canonical_application_id !== null) throw new SafeError('CONFLICT');
}
/** O advisory lock do proprietário estabiliza a cadeia antes dos locks de agregados.
 * UNION interrompe também uma cadeia inválida cíclica, sem escolher uma raiz fictícia. */
async function canonicalRoot(context: MutationContext, applicationId: string) {
  const roots = (await context.transaction.query<{ id: string }>(`WITH RECURSIVE lineage AS (
    SELECT id,canonical_application_id FROM career.applications WHERE owner_id=$1 AND id=$2
    UNION SELECT a.id,a.canonical_application_id FROM career.applications a JOIN lineage l ON a.id=l.canonical_application_id WHERE a.owner_id=$1
    ) SELECT id FROM lineage WHERE canonical_application_id IS NULL`, [context.ownerId, applicationId])).rows;
  return roots.length === 1 ? roots[0]!.id : null;
}
async function saveEvent(context: MutationContext, command: Extract<Command, { operation: 'record_event' | 'correct_event' }>) {
  const data = command.operation === 'record_event' ? command.data : command.replacement;
  if (data.kind === 'envio_confirmado') throw new SafeError('INVALID_INPUT');
  const prior = await priorCreation(context, 'event', command.clientId, command);
  const result = emptyActivityResult();
  if (prior) {
    result.existing = true; result.event = await activityEventProjection(context.transaction, context.ownerId, prior);
    result.parents = await parentRows(context, { application: command.application, contact: null }); return { status: 200, body: result };
  }
  await context.lockAggregates([{ table: 'applications', id: command.application.id }, ...(command.operation === 'correct_event' ? [{ table: 'events' as const, id: command.eventId }] : [])]);
  const parents = { application: command.application, contact: null }; const rows = await parentRows(context, parents); checkVersion(rows.application!, command.application);
  await assertWritableApplication(context, parents);
  let supersedesId: string | null = null;
  let eventApplicationId = command.application.id;
  if (command.operation === 'correct_event') {
    const source = (await context.transaction.query<{ kind: string; application_id: string }>('SELECT kind,application_id FROM career.events WHERE owner_id=$1 AND id=$2', [context.ownerId, command.eventId])).rows[0];
    if (!source || await canonicalRoot(context, source.application_id) !== command.application.id) throw new SafeError('NOT_FOUND');
    if (source.kind === 'envio_confirmado') throw new SafeError('INVALID_INPUT');
    if ((await context.transaction.query('SELECT id FROM career.events WHERE owner_id=$1 AND supersedes_event_id=$2', [context.ownerId, command.eventId])).rowCount) throw new SafeError('CONFLICT');
    supersedesId = command.eventId;
    // Mantém a FK histórica composta: o evento físico fica no alias original,
    // enquanto a versão autorizada/alterada é a do agregado lógico canônico.
    eventApplicationId = source.application_id;
  }
  const evidenceId = data.evidence ? await resolveActivityEvidence(context, data.evidence) : command.operation === 'correct_event' ? await resolveActivityEvidence(context, command.evidence) : null;
  const id = await insertActivityEvent(context, eventApplicationId, data, evidenceId, supersedesId);
  if (command.operation === 'correct_event') {
    const correctionEvidence = await resolveActivityEvidence(context, command.evidence);
    await insertActivityEvent(context, command.application.id, { kind: 'correcao', state: 'informado', occurredDate: { precision: 'unknown', value: null }, resultText: command.reason, scoreValue: null, scoreUnit: null, sourceText: id, evidence: null }, correctionEvidence);
  }
  result.parents = await advanceParents(context, parents);
  await mapCreation(context, 'event', command.clientId, command, id);
  result.event = await activityEventProjection(context.transaction, context.ownerId, id); return { status: 201, body: result };
}
async function saveContact(context: MutationContext, command: Extract<Command, { operation: 'save_contact' }>) {
  const target = command.target; const creating = 'clientId' in target;
  const prior = creating ? await priorCreation(context, 'contact', target.clientId, command) : undefined;
  const result = emptyActivityResult();
  if (prior) { result.existing = true; result.contact = await contactProjection(context.transaction, context.ownerId, prior); return { status: 200, body: result }; }
  const id = creating ? randomUUID() : target.id;
  let persistedLinks: typeof command.data.links = [];
  if (!creating) {
    await context.lockAggregates([{ table: 'contacts', id }]);
    const current = await contactProjection(context.transaction, context.ownerId, id); checkVersion(current, target);
    persistedLinks = current.links;
  }
  // Mesma identidade usada pelo INSERT: comparação recalculada não cria outro vínculo.
  const linkIdentity = (link: typeof command.data.links[number]) => JSON.stringify([link.originalUrl, link.kind, link.isLocal, link.isPrivate]);
  const existingLinks = new Set(persistedLinks.map(linkIdentity));
  const newLinks = new Set(command.data.links.map(linkIdentity).filter((identity) => !existingLinks.has(identity)));
  if (persistedLinks.length + newLinks.size > 50) throw new SafeError('INVALID_INPUT');
  if (!creating) {
    await context.transaction.query('UPDATE career.contacts SET name=$3,notes=$4,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [context.ownerId, id, command.data.name, command.data.notes]);
  } else await context.transaction.query('INSERT INTO career.contacts(id,owner_id,name,notes) VALUES($1,$2,$3,$4)', [id, context.ownerId, command.data.name, command.data.notes]);
  for (const link of command.data.links) {
    let comparison: string | null = null;
    if (!link.isLocal) { try { comparison = normalizeJobUrl(link.originalUrl); } catch { throw new SafeError('INVALID_INPUT'); } }
    await context.transaction.query(`INSERT INTO career.links(owner_id,contact_id,original_url,comparison_url,kind,is_local,is_private) SELECT $1,$2,$3,$4,$5,$6,$7 WHERE NOT EXISTS(SELECT 1 FROM career.links WHERE owner_id=$1 AND contact_id=$2 AND original_url=$3 AND kind=$5 AND is_local=$6 AND is_private=$7)`, [context.ownerId, id, link.originalUrl, comparison, link.kind, link.isLocal, link.isPrivate]);
  }
  if (creating) await mapCreation(context, 'contact', target.clientId, command, id);
  result.contact = await contactProjection(context.transaction, context.ownerId, id); return { status: creating ? 201 : 200, body: result };
}
async function saveTask(context: MutationContext, command: Extract<Command, { operation: 'save_task' | 'complete_task' }>) {
  const target = command.operation === 'save_task' ? command.target : command.task;
  const creating = 'clientId' in target;
  const prior = creating ? await priorCreation(context, 'task', target.clientId, command) : undefined;
  const result = emptyActivityResult();
  if (prior) { result.existing = true; result.task = await taskProjection(context.transaction, context.ownerId, prior); result.parents = await parentRows(context, command.parents); return { status: 200, body: result }; }
  const id = creating ? randomUUID() : target.id;
  const references: AggregateRef[] = [];
  if (command.parents.application) references.push({ table: 'applications', id: command.parents.application.id });
  if (command.parents.contact) references.push({ table: 'contacts', id: command.parents.contact.id });
  if (!creating) references.push({ table: 'tasks', id });
  await context.lockAggregates(references);
  await assertWritableApplication(context, command.parents);
  const parents = await parentRows(context, command.parents);
  if (command.parents.application) checkVersion(parents.application!, command.parents.application);
  if (command.parents.contact) checkVersion(parents.contact!, command.parents.contact);
  if (!creating) {
    const current = await taskProjection(context.transaction, context.ownerId, id); checkVersion(current, target);
    const logicalApplicationId = current.applicationId === null ? null : await canonicalRoot(context, current.applicationId);
    if (logicalApplicationId !== (command.parents.application?.id ?? null) || (current.applicationId !== null && logicalApplicationId === null) || current.contactId !== (command.parents.contact?.id ?? null)) throw new SafeError('CONFLICT');
    if (command.operation === 'complete_task' && current.status === 'completed') { result.task = current; result.parents = parents; return { status: 200, body: result }; }
  }
  if (command.operation === 'complete_task') await context.transaction.query("UPDATE career.tasks SET status='completed',completed_date=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [context.ownerId, id, command.completedDate]);
  else if (creating) await context.transaction.query('INSERT INTO career.tasks(id,owner_id,application_id,contact_id,title,due_date) VALUES($1,$2,$3,$4,$5,$6)', [id, context.ownerId, command.parents.application?.id ?? null, command.parents.contact?.id ?? null, command.data.title, command.data.dueDate]);
  else await context.transaction.query('UPDATE career.tasks SET title=$3,due_date=$4,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [context.ownerId, id, command.data.title, command.data.dueDate]);
  result.parents = await advanceParents(context, command.parents);
  if (creating) await mapCreation(context, 'task', target.clientId, command, id);
  result.task = await taskProjection(context.transaction, context.ownerId, id); return { status: creating ? 201 : 200, body: result };
}
/** Runtime restrito: sem identificação de pessoas, visitas a links ou notificações. */
export function createActivityService(database: ReturnType<typeof createDatabase>) {
  return createMutation(database, { operation: 'activity_command', commandSchema, responseSchema: activityResultSchema,
    async execute(context, command) {
      // Mesmo domínio de serialização dos serviços de candidatura; antes de qualquer linha.
      await context.transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`career.application-identity:${context.ownerId}`]);
      try {
        if (command.operation === 'record_event' || command.operation === 'correct_event') return await saveEvent(context, command);
        if (command.operation === 'save_contact') return await saveContact(context, command);
        if (command.operation === 'save_task' || command.operation === 'complete_task') return await saveTask(context, command);
        throw new SafeError('INVALID_INPUT');
      } catch (error) { if ((error as { code?: string }).code === '23505') throw new SafeError('CONFLICT'); throw error; }
    },
  });
}
/** Hoje usa somente dia civil exato; mês/ano/aproximação continuam sem prazo exato. */
export async function listTodayTasks(tx: Transaction, ownerId: string, today: string) {
  localDaySchema.parse(today);
  const tasks = await listPendingTasks(tx, ownerId);
  const rank = { overdue: 0, today: 1, future: 2, no_exact_deadline: 3 };
  return tasks.map((task) => {
    const dueDay = toLocalDay(task.dueDate);
    const dueGroup: keyof typeof rank = dueDay === null ? 'no_exact_deadline' : dueDay < today ? 'overdue' : dueDay === today ? 'today' : 'future';
    return { ...task, dueDay, dueGroup };
  }).sort((a, b) => rank[a.dueGroup] - rank[b.dueGroup] || (a.dueDay ?? '').localeCompare(b.dueDay ?? ''));
}
