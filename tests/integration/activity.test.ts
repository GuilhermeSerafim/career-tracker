import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticatedAgentFixture } from '../helpers/agent';
import { authenticateBearer, type AuthenticatedActor } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase } from '../../server/database';
import type { AuthenticatedTransaction, RequestContext } from '../../server/database';
import { createApplicationService } from '../../server/services/applications';
import { createActivityService, listTodayTasks } from '../../server/services/activity';
import { provisionOwner } from '../../scripts/provision-owner';
import { connectTestDatabase } from '../helpers/database';
import { day, unknownDate } from '../fixtures/career';
import { listApplicationEvents } from '../../server/repositories/activity';
import { analyticsEventSchema, analyticsRowSchema } from '../../shared/analytics';
import { buildAnalytics } from '../../domain/metrics';


const evidence = () => ({ clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Relato fictício do usuário.', source: 'usuário', occurredDate: unknownDate, privateRef: null, localRef: null });
const eventData = (kind = 'avaliacao') => ({ kind, state: 'concluido', occurredDate: unknownDate, resultText: '79% informado', scoreValue: 79, scoreUnit: '%', sourceText: 'relato do usuário', evidence: evidence() });
const save = (stage = 'desconhecida') => ({ operation: 'save_application', clientId: randomUUID(), data: { opportunity: { company: 'Empresa fictícia', title: 'Engenharia', platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'vaga', seniority: null, modality: null, description: null, stack: [], identities: [] }, track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: unknownDate, stage, cycleRelation: 'before_reset', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [], links: [] }, evidence: evidence() });

describe('histórico, contatos e próximas ações pelo login restrito', () => {
  const owner = randomUUID(); let db: pg.Client;
  let first: ReturnType<typeof createDatabase>; let second: ReturnType<typeof createDatabase>;
  let actor: Awaited<ReturnType<typeof authenticateBearer>>; let otherActor: AuthenticatedActor;
  let service: ReturnType<typeof createActivityService>; let applications: ReturnType<typeof createApplicationService>;
  beforeAll(async () => {
    db = await connectTestDatabase(); const password = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword: password, restorePassword: randomBytes(32).toString('base64url') });
    const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!); url.username = 'career_api'; url.password = password;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', DATABASE_POOL_MAX: '1', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    first = createDatabase(config); second = createDatabase(config); service = createActivityService(first); applications = createApplicationService(first);
    actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
    otherActor = await authenticatedAgentFixture(first, config, actor);
  });
  afterAll(async () => {
    await first?.close(); await second?.close();
    if (db) {
      await db.query('BEGIN'); await db.query("SET LOCAL session_replication_role='replica'");
      for (const table of ['agent_credentials', 'mutation_keys', 'creation_requests', 'tasks', 'contacts', 'links', 'events', 'evidence', 'applications', 'opportunities', 'owner_settings', 'audit_log', 'maintenance_state', 'owner_config']) await db.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
      await db.query('COMMIT'); await db.end();
    }
  });
  const call = (command: unknown, api = service, who: AuthenticatedActor = actor, key = randomUUID()) => api(who, { idempotencyKey: key, command });
  const app = async (stage?: string) => (await applications(actor, { idempotencyKey: randomUUID(), command: save(stage) })).body.application!;
  const ref = (value: { id: string; version: number }) => ({ id: value.id, expectedVersion: value.version });
  const events = async (id: string) => (await db.query('SELECT * FROM career.events WHERE application_id=$1 ORDER BY created_at,id', [id])).rows;
  async function captureDatabaseTime() {
    const result = await db.query<{ instant: string }>(`SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant`);
    return result.rows[0]!.instant;
  }

  it('registra avaliação retrospectiva sem inventar data, aprovação ou outro envio; retry entre atores é durável', async () => {
    const a = await app(); const command = { operation: 'record_event', clientId: randomUUID(), application: ref(a), data: eventData() };
    const firstResult = await call(command); const retry = await call(command, createActivityService(second), otherActor);
    expect(retry.body.event?.id).toBe(firstResult.body.event?.id);
    await expect(call({ ...command, data: { ...command.data, scoreValue: 80 } })).rejects.toMatchObject({ status: 409 });
    expect((await events(a.id)).filter((e) => e.kind === 'avaliacao')).toMatchObject([{ state: 'concluido', occurred_date: unknownDate, score_value: '79', score_unit: '%', result_text: '79% informado', source_text: 'relato do usuário' }]);
    expect((await db.query('SELECT version,submission_status,submitted_date,cycle_relation,cycle_order,stage FROM career.applications WHERE id=$1', [a.id])).rows[0]).toEqual({ version: 2, submission_status: 'confirmado', submitted_date: unknownDate, cycle_relation: 'before_reset', cycle_order: null, stage: 'desconhecida' });
    expect((await events(a.id)).filter((e) => e.kind === 'envio_confirmado')).toHaveLength(1);
    expect((await db.query("SELECT actor_kind,source FROM career.audit_log WHERE entity_type='events' AND entity_id=$1", [firstResult.body.event!.id])).rows).toEqual([{ actor_kind: 'owner', source: 'web' }]);
    await expect(call({ ...command, clientId: randomUUID(), application: { id: a.id, expectedVersion: 2 }, data: eventData('envio_confirmado') })).rejects.toMatchObject({ status: 400 });
  });
  it('correção preserva original e exige predecessor efetivo na mesma candidatura', async () => {
    const a = await app(); const b = await app();
    const initial = (await call({ operation: 'record_event', clientId: randomUUID(), application: ref(a), data: eventData('entrevista') })).body.event!;
    const correction = { operation: 'correct_event', clientId: randomUUID(), application: { id: a.id, expectedVersion: 2 }, eventId: initial.id, replacement: eventData('nota'), reason: 'O relato era preparação, não entrevista.', evidence: evidence() };
    await expect(call({ ...correction, application: ref(b) })).rejects.toMatchObject({ status: 404 });
    const result = await call(correction); const replacement = result.body.event!;
    expect(replacement.supersedesEventId).toBe(initial.id);
    const before = await events(a.id);
    await expect(call({ ...correction, clientId: randomUUID(), application: { id: a.id, expectedVersion: 3 } })).rejects.toMatchObject({ status: 409 });
    expect(await events(a.id)).toEqual(before);
    expect(before.find((e) => e.id === initial.id)?.kind).toBe('entrevista');
    expect((await db.query('SELECT original_text FROM career.evidence WHERE id=$1', [replacement.evidenceId])).rows[0].original_text).toBe('Relato fictício do usuário.');
    expect(before.some((e) => e.result_text === correction.reason)).toBe(true);
    await call({ ...correction, clientId: randomUUID(), application: { id: a.id, expectedVersion: 3 }, eventId: replacement.id, replacement: eventData('entrevista') });
    expect((await events(a.id)).filter((e) => e.supersedes_event_id)).toHaveLength(2);
    await expect(call({ ...correction, clientId: randomUUID(), application: { id: a.id, expectedVersion: 4 }, eventId: replacement.id, replacement: eventData('envio_confirmado') })).rejects.toMatchObject({ status: 400 });
  });
  it('salvar e alterar etapa preserva entrevista alcançada antes da rejeição, sem evento no-op', async () => {
    const a = await app('entrevista'); const initial = await events(a.id);
    expect(initial.filter((e) => e.kind === 'entrevista')).toMatchObject([{ state: 'informado', occurred_date: unknownDate }]);
    const update = (stage: string, version: number) => applications(actor, { idempotencyKey: randomUUID(), command: { operation: 'update_application', application: { id: a.id, expectedVersion: version }, changes: { stage } } });
    await update('entrevista', 1); expect(await events(a.id)).toEqual(initial);
    await update('rejeicao', 2);
    expect((await events(a.id)).map((e) => e.kind).sort()).toEqual(['entrevista', 'envio_confirmado', 'rejeicao']);
    expect((await db.query('SELECT stage,submission_status,cycle_relation FROM career.applications WHERE id=$1', [a.id])).rows[0]).toEqual({ stage: 'rejeicao', submission_status: 'confirmado', cycle_relation: 'before_reset' });
    const history = await first.transaction(actor, (tx) => listApplicationEvents(tx, owner, a.id));
    const metrics = buildAnalytics([analyticsRowSchema.strip().parse({ ...a, stage: 'rejeicao', company: 'Empresa fictícia', title: 'Engenharia', seniority: null, modality: null, batchIds: [] })], history.map((event) => analyticsEventSchema.strip().parse(event)), { operation: 'metrics', period: { from: '2026-11-16', to: '2026-11-16' }, population: 'confirmed', dimension: 'stack', submissionScope: 'all_dates', dailyGoal: 1, asOf: await captureDatabaseTime() });
    expect(metrics.conversions.interview).toEqual({ numerator: 1, denominator: 1, ratio: 1, applicationIds: [a.id] });
    expect(metrics.completed.interview.count).toBe(0); expect(metrics.conversions.response.numerator).toBe(0); expect(metrics.comparison.actual).toBe(0);
  });
  it('mapeia somente fatos explícitos de etapa e preserva texto original genérico', async () => {
    for (const [stage, kind] of [['avaliacao', 'avaliacao'], ['proposta', 'proposta'], ['contratacao', 'contratacao'], ['desistencia', 'desistencia'], ['processo_encerrado', 'encerramento'], ['triagem', 'etapa_alterada'], ['candidatura_enviada', 'etapa_alterada']] as const) {
      const a = await app(stage); const history = await events(a.id);
      expect(history.filter((e) => e.kind !== 'envio_confirmado')).toMatchObject([{ kind, state: 'informado', occurred_date: unknownDate, source_text: stage, score_value: null }]);
    }
  });
  it('contato opcional mantém nome informado e links originais com comparação recalculada', async () => {
    const command = { operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: '  Ana X  ', notes: 'Não identificar a pessoa.', links: [{ originalUrl: 'https://example.org/Person?utm_source=x&id=42', comparisonUrl: 'https://forged.invalid', kind: 'perfil', isLocal: false, isPrivate: true }, { originalUrl: 'C:/referencias/ana.txt', comparisonUrl: 'forjado', kind: 'referência local', isLocal: true, isPrivate: true }] } };
    const result = await call(command); const contact = result.body.contact!;
    expect(contact.name).toBe('  Ana X  ');
    expect(contact.links.find((link) => link.originalUrl.startsWith('https:'))?.comparisonUrl).toBe('https://example.org/Person?id=42');
    expect(contact.links.find((link) => link.isLocal)).toMatchObject({ originalUrl: 'C:/referencias/ana.txt', comparisonUrl: null });
    expect((await call(command, createActivityService(second), otherActor)).body.contact?.id).toBe(contact.id);
    await expect(call({ ...command, data: { ...command.data, name: 'Nome diferente' } })).rejects.toMatchObject({ status: 409 });
    await expect(call({ ...command, target: { id: contact.id, expectedVersion: 2 } })).rejects.toMatchObject({ status: 409 });
    await expect(call({ ...command, target: { clientId: randomUUID() }, data: { ...command.data, links: [{ ...command.data.links[0], originalUrl: 'https://user:secret@example.org/' }] } })).rejects.toMatchObject({ status: 400 });
    const anonymous = await call({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: null, notes: null, links: [] } }); expect(anonymous.body.contact?.name).toBeNull();
  });
  it('limita contato a 50 links cumulativos sem contar duplicatas nem impedir notas/retries', async () => {
    const links = Array.from({ length: 50 }, (_, i) => ({ originalUrl: `https://example.org/reference/${i}`, comparisonUrl: null, kind: 'referência', isLocal: false, isPrivate: true }));
    const create = { operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: 'Contato fictício', notes: null, links } };
    const created = await call(create); const contact = created.body.contact!;
    expect(contact.links).toHaveLength(50); expect(contact.version).toBe(1);
    const inventory = async () => ({
      contact: (await db.query('SELECT * FROM career.contacts WHERE id=$1', [contact.id])).rows,
      links: (await db.query('SELECT * FROM career.links WHERE contact_id=$1 ORDER BY id', [contact.id])).rows,
      counts: (await db.query('SELECT (SELECT count(*) FROM career.evidence WHERE owner_id=$1)::int AS evidence,(SELECT count(*) FROM career.mutation_keys WHERE owner_id=$1)::int AS keys,(SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audit,(SELECT count(*) FROM career.creation_requests WHERE owner_id=$1)::int AS mappings', [owner])).rows,
    });
    const before = await inventory(); const rejectedKey = randomUUID();
    await expect(call({ operation: 'save_contact', target: ref(contact), data: { name: 'Não persistir', notes: 'Também não persistir', links: [{ ...links[0], originalUrl: 'https://example.org/reference/51' }] } }, service, actor, rejectedKey)).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(await inventory()).toEqual(before);
    expect((await db.query('SELECT id FROM career.mutation_keys WHERE idempotency_key=$1', [rejectedKey])).rowCount).toBe(0);
    const noteCommand = { operation: 'save_contact', target: ref(contact), data: { name: contact.name, notes: 'Nota permitida no limite.', links: [] } }; const noteKey = randomUUID();
    const noted = await call(noteCommand, service, actor, noteKey);
    expect(noted.body.contact).toMatchObject({ version: 2, notes: 'Nota permitida no limite.' }); expect(noted.body.contact?.links).toHaveLength(50);
    expect((await call(noteCommand, service, actor, noteKey)).body).toEqual(noted.body);
    const duplicates = await call({ ...noteCommand, target: { id: contact.id, expectedVersion: 2 }, data: { ...noteCommand.data, links: Array.from({ length: 50 }, () => links[0]) } });
    expect(duplicates.body.contact?.links).toHaveLength(50); expect(duplicates.body.contact?.version).toBe(3);
    expect((await call(create, createActivityService(second), otherActor)).body.contact?.id).toBe(contact.id);
  });
  it('tarefa com dois pais valida todas as versões, conclui idempotentemente e preserva data desconhecida', async () => {
    const a = await app(); const contact = (await call({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: 'B', notes: null, links: [] } })).body.contact!;
    const command = { operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: ref(a), contact: ref(contact) }, data: { title: 'Preparar conversa', dueDate: unknownDate } };
    const result = await call(command); const task = result.body.task!;
    expect(result.body.parents).toEqual({ application: { id: a.id, version: 2 }, contact: { id: contact.id, version: 2 } });
    expect((await call(command, createActivityService(second), otherActor)).body.task?.id).toBe(task.id);
    await expect(call({ ...command, target: { id: task.id, expectedVersion: 1 } })).rejects.toMatchObject({ status: 409 });
    const parents = { application: { id: a.id, expectedVersion: 2 }, contact: { id: contact.id, expectedVersion: 2 } };
    await expect(call({ ...command, target: { id: task.id, expectedVersion: 1 }, parents: { ...parents, contact: { id: contact.id, expectedVersion: 1 } } })).rejects.toMatchObject({ status: 409 });
    await expect(call({ ...command, target: { id: task.id, expectedVersion: 2 }, parents })).rejects.toMatchObject({ status: 409 });
    await expect(call({ ...command, target: { id: task.id, expectedVersion: 1 }, parents: { ...parents, contact: null } })).rejects.toMatchObject({ status: 409 });
    const complete = { operation: 'complete_task', task: ref(task), parents, completedDate: unknownDate }; const key = randomUUID();
    const done = await call(complete, service, actor, key); expect(done.body.task).toMatchObject({ status: 'completed', version: 2, completedDate: unknownDate });
    expect((await call(complete, service, actor, key)).body).toEqual(done.body);
    await expect(call(complete)).rejects.toMatchObject({ status: 409 });
    const repeated = await call({ ...complete, task: { id: task.id, expectedVersion: 2 }, parents: { application: { id: a.id, expectedVersion: 3 }, contact: { id: contact.id, expectedVersion: 3 } }, completedDate: day('2026-11-16') });
    expect(repeated.body.task).toEqual(done.body.task); expect(repeated.body.parents).toEqual(done.body.parents);
    expect((await events(a.id)).filter((e) => e.kind === 'envio_confirmado')).toHaveLength(1);
    await expect(call({ ...command, target: { clientId: randomUUID() }, parents: { application: { id: randomUUID(), expectedVersion: 1 }, contact: null } })).rejects.toMatchObject({ status: 404 });
  });
  it('Hoje ordena apenas dias locais exatos e preserva precisão/ausência', async () => {
    const a = await app(); let version = 1;
    const dates = [unknownDate, { precision: 'month', certainty: 'exact', value: '2026-10' }, day('2026-11-17'), day('2026-11-16'), day('2026-11-15'), { precision: 'day', certainty: 'approximate', value: '2026-11-14' }, { precision: 'instant', certainty: 'exact', value: '2026-11-17T01:00:00Z' }];
    for (const [i, dueDate] of dates.entries()) await call({ operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: { id: a.id, expectedVersion: version++ }, contact: null }, data: { title: `ação ${i}`, dueDate } });
    const listed = await first.transaction(actor, (tx) => listTodayTasks(tx, owner, '2026-11-16'));
    expect(listed.filter((t) => t.applicationId === a.id).map((t) => [t.title, t.dueGroup])).toEqual([['ação 4', 'overdue'], ['ação 3', 'today'], ['ação 6', 'today'], ['ação 2', 'future'], ['ação 0', 'no_exact_deadline'], ['ação 1', 'no_exact_deadline'], ['ação 5', 'no_exact_deadline']]);
    expect(listed.find((t) => t.title === 'ação 1')?.dueDate).toEqual(dates[1]);
  });
  it('falha injetada após evento, evidência e mapping reverte também versão e auditoria', async () => {
    const a = await app(); const before = await events(a.id);
    const inventory = async () => (await db.query(`SELECT (SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audit,(SELECT count(*) FROM career.evidence WHERE owner_id=$1)::int AS evidence,(SELECT count(*) FROM career.creation_requests WHERE owner_id=$1)::int AS mappings`, [owner])).rows;
    const counts = await inventory();
    const failing = { ...first, async transaction<T>(who: typeof actor, work: (tx: AuthenticatedTransaction) => Promise<T>, context?: RequestContext) {
      return first.transaction(who, (tx) => work({ ...tx, query: async <Row extends pg.QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await tx.query<Row>(sql, values); if (sql.startsWith('INSERT INTO career.creation_requests') && values?.[1] === 'event') throw new Error('Falha fictícia após mapping.'); return result;
      } }), context);
    } };
    await expect(call({ operation: 'record_event', clientId: randomUUID(), application: ref(a), data: eventData() }, createActivityService(failing))).rejects.toMatchObject({ status: 503 });
    expect(await events(a.id)).toEqual(before); expect(await inventory()).toEqual(counts);
    expect((await db.query('SELECT version FROM career.applications WHERE id=$1', [a.id])).rows[0].version).toBe(1);
  });
  it('duas criações simultâneas com mesmos pais usam ordem estável e só uma versão vence', async () => {
    const a = await app(); const c = (await call({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: 'C', notes: null, links: [] } })).body.contact!;
    const command = () => ({ operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: ref(a), contact: ref(c) }, data: { title: 'Próxima ação', dueDate: unknownDate } });
    const outcomes = await Promise.allSettled([call(command()), call(command(), createActivityService(second))]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect((await db.query('SELECT version FROM career.contacts WHERE id=$1', [c.id])).rows[0].version).toBe(2);
    expect((await db.query('SELECT version FROM career.applications WHERE id=$1', [a.id])).rows[0].version).toBe(2);
    expect((await db.query('SELECT count(*)::int AS n FROM career.tasks WHERE application_id=$1 AND contact_id=$2', [a.id, c.id])).rows[0].n).toBe(1);
  });
  it('edita tarefa/contato e recusa clientId de tarefa com corpo diferente sem alterar versões', async () => {
    const c = (await call({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: 'D', notes: null, links: [] } })).body.contact!;
    const create = { operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: null, contact: ref(c) }, data: { title: 'Preparar', dueDate: unknownDate } };
    const task = (await call(create)).body.task!;
    await expect(call({ ...create, data: { ...create.data, title: 'Outro título' } })).rejects.toMatchObject({ status: 409 });
    const update = await call({ ...create, target: { id: task.id.toUpperCase(), expectedVersion: 1 }, parents: { application: null, contact: { id: c.id.toUpperCase(), expectedVersion: 2 } }, data: { title: 'Revisar conversa', dueDate: day('2026-11-17') } });
    expect(update.body.task).toMatchObject({ id: task.id, version: 2, title: 'Revisar conversa', dueDate: day('2026-11-17') });
    expect(update.body.parents.contact?.version).toBe(3);
    const changed = await call({ operation: 'save_contact', target: { id: c.id, expectedVersion: 3 }, data: { name: '  D informado  ', notes: 'Observação', links: [] } });
    expect(changed.body.contact).toMatchObject({ name: '  D informado  ', version: 4, notes: 'Observação' });
  });
  it('referências de outro owner são indistinguíveis de ausentes e não gravam parcialmente', async () => {
    const foreignOwner = randomUUID(); const foreignContact = randomUUID(); const foreignEvidence = randomUUID();
    // Somente fixture administrativa; todas as tentativas abaixo usam career_api com RLS.
    await db.query('INSERT INTO career.contacts(id,owner_id,name) VALUES($1,$2,$3)', [foreignContact, foreignOwner, 'Pessoa fictícia privada']);
    await db.query("INSERT INTO career.evidence(id,owner_id,kind,original_text) VALUES($1,$2,'relato_usuario','Relato fictício privado')", [foreignEvidence, foreignOwner]);
    try {
      const a = await app(); const inventory = async () => (await db.query('SELECT (SELECT count(*) FROM career.tasks WHERE owner_id=$1)::int AS tasks,(SELECT count(*) FROM career.events WHERE owner_id=$1)::int AS events,(SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audit', [owner])).rows;
      const before = await inventory();
      for (const id of [foreignContact, randomUUID()]) {
        await expect(call({ operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: ref(a), contact: { id, expectedVersion: 1 } }, data: { title: 'Inválida', dueDate: unknownDate } })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
        await expect(call({ operation: 'save_contact', target: { id, expectedVersion: 1 }, data: { name: null, notes: null, links: [] } })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      }
      await expect(call({ operation: 'record_event', clientId: randomUUID(), application: ref(a), data: { ...eventData(), evidence: { id: foreignEvidence } } })).rejects.toMatchObject({ status: 404 });
      expect(await inventory()).toEqual(before);
      expect((await db.query('SELECT version FROM career.applications WHERE id=$1', [a.id])).rows[0].version).toBe(1);
    } finally {
      await db.query('DELETE FROM career.evidence WHERE owner_id=$1', [foreignOwner]); await db.query('DELETE FROM career.contacts WHERE owner_id=$1', [foreignOwner]);
    }
  });
  it('recusa novos eventos/tarefas no alias redirecionado sem alterar histórico ou versão canônica', async () => {
    const old = await app(); const canonical = await app();
    // Fixture de redirect já coberto pelo serviço de candidatura em seu teste próprio.
    await db.query('UPDATE career.applications SET canonical_application_id=$2,counting_eligible=false WHERE id=$1', [old.id, canonical.id]);
    const before = await events(old.id);
    await expect(call({ operation: 'record_event', clientId: randomUUID(), application: ref(old), data: eventData() })).rejects.toMatchObject({ status: 409 });
    await expect(call({ operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: ref(old), contact: null }, data: { title: 'Precisa reler canônica', dueDate: unknownDate } })).rejects.toMatchObject({ status: 409 });
    expect(await events(old.id)).toEqual(before);
    expect((await db.query('SELECT version FROM career.applications WHERE id=ANY($1::uuid[])', [[old.id, canonical.id]])).rows).toEqual([{ version: 1 }, { version: 1 }]);
    const history = await first.transaction(actor, (tx) => listApplicationEvents(tx, owner, canonical.id));
    expect(history.map((e) => e.id).sort()).toEqual([...before.map((e) => e.id), ...(await events(canonical.id)).map((e) => e.id)].sort());
  });
  it('entrevista seguida de rejeição por eventos não exige sequência universal nem altera etapa/envio', async () => {
    const a = await app(); const firstEvent = { operation: 'record_event', clientId: randomUUID(), application: ref(a), data: { ...eventData('entrevista'), state: 'agendado', scoreValue: null, scoreUnit: null } };
    await call(firstEvent);
    await expect(call({ ...firstEvent, clientId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await call({ operation: 'record_event', clientId: randomUUID(), application: { id: a.id, expectedVersion: 2 }, data: { ...eventData('rejeicao'), state: 'informado', scoreValue: null, scoreUnit: null } });
    const history = await first.transaction(actor, (tx) => listApplicationEvents(tx, owner, a.id));
    expect(history.map((e) => e.kind).sort()).toEqual(['entrevista', 'envio_confirmado', 'rejeicao']);
    expect((await db.query('SELECT stage,submission_status,cycle_relation,version FROM career.applications WHERE id=$1', [a.id])).rows[0]).toEqual({ stage: 'desconhecida', submission_status: 'confirmado', cycle_relation: 'before_reset', version: 3 });
  });
  it('corrige histórico do alias pela versão canônica sem alterar metadados do alias', async () => {
    const alias = await app(); const canonical = await app(); const unrelated = await app();
    const original = (await call({ operation: 'record_event', clientId: randomUUID(), application: ref(alias), data: eventData('avaliacao') })).body.event!;
    await db.query('UPDATE career.applications SET canonical_application_id=$2,counting_eligible=false WHERE id=$1', [alias.id, canonical.id]);
    const aliasBefore = (await db.query('SELECT * FROM career.applications WHERE id=$1', [alias.id])).rows;
    const command = { operation: 'correct_event', clientId: randomUUID(), application: ref(canonical), eventId: original.id, replacement: { ...eventData('entrevista'), state: 'informado', scoreValue: null, scoreUnit: null }, reason: 'Era entrevista, conforme relato corrigido.', evidence: evidence() };
    await expect(call({ ...command, application: ref(unrelated) })).rejects.toMatchObject({ status: 404 });
    const corrected = await call(command);
    expect(corrected.body.event).toMatchObject({ applicationId: alias.id, kind: 'entrevista', supersedesEventId: original.id });
    expect(corrected.body.parents.application).toEqual({ id: canonical.id, version: 2 });
    expect((await db.query('SELECT * FROM career.applications WHERE id=$1', [alias.id])).rows).toEqual(aliasBefore);
    expect((await events(alias.id)).find((e) => e.id === original.id)?.kind).toBe('avaliacao');
    expect((await call(command, createActivityService(second), otherActor)).body.event?.id).toBe(corrected.body.event?.id);
    const history = await first.transaction(actor, (tx) => listApplicationEvents(tx, owner, canonical.id));
    const analytical = (a: typeof alias, changes = {}) => analyticsRowSchema.strip().parse({ ...a, company: 'Empresa fictícia', title: 'Engenharia', seniority: null, modality: null, batchIds: [], ...changes });
    const metrics = buildAnalytics([analytical(alias, { canonicalApplicationId: canonical.id, countingEligible: false }), analytical(canonical)], history.map((e) => analyticsEventSchema.strip().parse(e)), { operation: 'metrics', period: { from: '2026-11-16', to: '2026-11-16' }, population: 'confirmed', dimension: 'stack', submissionScope: 'all_dates', dailyGoal: 1, asOf: await captureDatabaseTime() });
    expect(metrics.conversions.interview).toEqual({ numerator: 1, denominator: 1, ratio: 1, applicationIds: [canonical.id] });
    expect(metrics.conversions.assessment.numerator).toBe(0);
    expect(metrics.supersededEventIds).toContain(original.id);
    await expect(call({ ...command, clientId: randomUUID(), application: { id: canonical.id, expectedVersion: 2 } })).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT version FROM career.applications WHERE id=$1', [canonical.id])).rows[0].version).toBe(2);
    expect((await db.query('SELECT version FROM career.applications WHERE id=$1', [unrelated.id])).rows[0].version).toBe(1);
  });
  it('falha após todos os registros de tarefa reverte pais, tarefa, mapping e auditoria', async () => {
    const a = await app(); const c = (await call({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: null, notes: null, links: [] } })).body.contact!;
    const inventory = async () => (await db.query(`SELECT (SELECT count(*) FROM career.tasks WHERE owner_id=$1)::int AS tasks,(SELECT count(*) FROM career.creation_requests WHERE owner_id=$1)::int AS mappings,(SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audit`, [owner])).rows;
    const before = await inventory();
    const failing = { ...first, async transaction<T>(who: typeof actor, work: (tx: AuthenticatedTransaction) => Promise<T>, context?: RequestContext) {
      return first.transaction(who, (tx) => work({ ...tx, query: async <Row extends pg.QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await tx.query<Row>(sql, values); if (sql.startsWith('UPDATE career.mutation_keys SET http_status')) throw new Error('Falha fictícia antes de commit.'); return result;
      } }), context);
    } };
    const command = { operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: ref(a), contact: ref(c) }, data: { title: 'Preparar', dueDate: day('2026-11-17') } };
    await expect(call(command, createActivityService(failing))).rejects.toMatchObject({ status: 503 });
    expect(await inventory()).toEqual(before);
    expect((await db.query('SELECT version FROM career.applications WHERE id=$1', [a.id])).rows[0].version).toBe(1);
    expect((await db.query('SELECT version FROM career.contacts WHERE id=$1', [c.id])).rows[0].version).toBe(1);
    const task = (await call(command)).body.task!;
    const done = await call({ operation: 'complete_task', task: ref(task), parents: { application: { id: a.id, expectedVersion: 2 }, contact: { id: c.id, expectedVersion: 2 } }, completedDate: day('2026-11-14') });
    expect(done.body.task?.completedDate).toEqual(day('2026-11-14'));
    expect((await db.query('SELECT created_at::date::text AS day FROM career.tasks WHERE id=$1', [task.id])).rows[0].day).not.toBe('2026-11-14');
  });
  it('conclui tarefa anterior ao merge pela versão canônica sem reparentar ou alterar alias', async () => {
    const alias = await app(); const canonical = await app(); const unrelated = await app();
    const task = (await call({ operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: ref(alias), contact: null }, data: { title: 'Retomar conversa', dueDate: unknownDate } })).body.task!;
    await db.query('UPDATE career.applications SET canonical_application_id=$2,counting_eligible=false WHERE id=$1', [alias.id, canonical.id]);
    const before = (await db.query('SELECT * FROM career.applications WHERE id=$1', [alias.id])).rows;
    const command = { operation: 'complete_task', task: ref(task), parents: { application: ref(canonical), contact: null }, completedDate: day('2026-11-16') };
    await expect(call({ ...command, parents: { application: ref(unrelated), contact: null } })).rejects.toMatchObject({ status: 409 });
    const completed = await call(command);
    expect(completed.body.task).toMatchObject({ applicationId: alias.id, status: 'completed', version: 2 });
    expect(completed.body.parents.application).toEqual({ id: canonical.id, version: 2 });
    expect((await db.query('SELECT * FROM career.applications WHERE id=$1', [alias.id])).rows).toEqual(before);
    const edited = await call({ operation: 'save_task', target: { id: task.id, expectedVersion: 2 }, parents: { application: { id: canonical.id, expectedVersion: 2 }, contact: null }, data: { title: 'Conversa registrada', dueDate: unknownDate } });
    expect(edited.body.task).toMatchObject({ applicationId: alias.id, title: 'Conversa registrada', version: 3 });
    expect(edited.body.parents.application?.version).toBe(3);
  });
});
