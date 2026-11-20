import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { authenticatedAgentFixture } from '../helpers/agent';
import { authenticateBearer, type AuthenticatedActor } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase } from '../../server/database';

import { createApplicationService } from '../../server/services/applications';
import { createReviewService, createReviewReadService, createReviewAreaService } from '../../server/services/reviews';
import { createActivityService } from '../../server/services/activity';
import type { AuthenticatedTransaction, RequestContext } from '../../server/database';
import { provisionOwner } from '../../scripts/provision-owner';
import { connectTestDatabase, expectSqlState } from '../helpers/database';
import { day, unknownDate } from '../fixtures/career';
import { applicationResultSchema } from '../../shared/application-results';
import { buildReviewSnapshot } from '../../domain/cycles';
import { loadReviewProjection } from '../../server/repositories/reviews';
import { reviewSnapshotSchema } from '../../shared/transfer';




const opportunity = () => ({ company: 'Empresa fictícia', title: 'Engenharia', platform: 'portal', tenant: randomUUID() as string | null, jobCode: '42', jobKey: null, kind: 'vaga' as const, seniority: null, modality: null, description: null, stack: [], identities: [] as { provider: string; tenant: string; kind: 'job_code' | 'verified_alias'; value: string; verificationEvidence: ReturnType<typeof evidence> | null }[] });
const evidence = () => ({ clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Relato fictício de envio.', source: null, occurredDate: unknownDate, privateRef: null, localRef: null });
const save = () => ({ operation: 'save_application', clientId: randomUUID(), data: { opportunity: opportunity(), track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: unknownDate, stage: 'desconhecida', cycleRelation: 'unknown', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [] as string[], links: [] }, evidence: evidence() });

describe('candidaturas via login restrito em duas conexões', () => {
  const owner = randomUUID(); let db: pg.Client;
  let first: ReturnType<typeof createDatabase>; let second: ReturnType<typeof createDatabase>;
  let actor: Awaited<ReturnType<typeof authenticateBearer>>; let actorAgain: AuthenticatedActor;
  let service: ReturnType<typeof createApplicationService>;
  let restoreUrl: string;
  beforeAll(async () => {
    db = await connectTestDatabase();
    const password = randomBytes(32).toString('base64url');
    const restorePassword = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword: password, restorePassword });
    const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!); url.username = 'career_api'; url.password = password;
    const maintenanceUrl = new URL(url); maintenanceUrl.username = 'career_restore'; maintenanceUrl.password = restorePassword; restoreUrl = maintenanceUrl.href;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', DATABASE_POOL_MAX: '1', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    first = createDatabase(config); second = createDatabase(config); service = createApplicationService(first);
    const auth = () => authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
    actor = await auth();
    actorAgain = await authenticatedAgentFixture(first, config, actor);
  });
  afterAll(async () => {
    await first?.close(); await second?.close();
    if (db) {
      // Limpeza de fixtures fechadas pelo administrador do banco dedicado, nunca pelo runtime.
      await db.query('BEGIN'); await db.query("SET LOCAL session_replication_role='replica'");
      for (const table of ['agent_credentials', 'mutation_keys', 'creation_requests', 'review_versions', 'batch_members', 'batches', 'cycles', 'application_resumes', 'links', 'events', 'evidence', 'resume_refs', 'applications', 'opportunity_identities', 'opportunities', 'owner_settings', 'audit_log', 'maintenance_state', 'owner_config']) await db.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
      await db.query('COMMIT');
      await db.end();
    }
  });
  // Each case owns its fixture. Preserve only the real credential and owner.
  beforeEach(async () => {
    await db.query('BEGIN');
    try {
      await db.query("SET LOCAL session_replication_role='replica'");
      const tables = (await db.query<{ name: string }>("SELECT relname AS name FROM pg_class WHERE relnamespace='career'::regnamespace AND relkind='r' AND relname NOT IN ('owner_config','maintenance_state','agent_credentials')")).rows;
      for (const { name } of tables) {
        if (!/^[a-z_]+$/.test(name)) throw Error('Invalid fixture table');
        await db.query(`DELETE FROM career.${name} WHERE owner_id=$1`, [owner]);
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });
  let running: Promise<void> | undefined;
  // Vitest deadlines do not cancel promises: drain before the next fixture.
  afterEach(async () => { await running?.catch(() => undefined); running = undefined; }, 45_000);
  function register(name: string, work: () => Promise<void>, timeout = 15_000, initialize = true) {
    vitestIt(name, async () => {
      running = (async () => {
        if (initialize) await reviewCall({ operation: 'start_cycle', clientId: randomUUID(), resetDate: unknownDate, resetMarker: null });
        await work();
      })();
      await running;
    }, timeout);
  }
  const it = (name: string, work: () => Promise<void>, timeout?: number) => register(name, work, timeout);
  const emptyIt = (name: string, work: () => Promise<void>, timeout?: number) => register(name, work, timeout, false);
  async function seededBatch(count = 1, close = true) {
    let batch = '';
    for (let index = 0; index < count; index++) {
      const command = save(); command.data.cycleRelation = 'after_reset';
      const app = await application(command);
      batch = (await db.query('SELECT batch_id FROM career.batch_members WHERE application_id=$1', [app.id])).rows[0].batch_id;
    }
    if (close) {
      await db.query("UPDATE career.batches SET target=$2,status='pending' WHERE id=$1", [batch, count]);
      await reviewCall({ operation: 'close_review', batch: await batchRef(batch), narrative: null, decisions: [] });
    }
    return batch;
  }
  const call = (command: unknown, api = service, who: AuthenticatedActor = actor, key = randomUUID()) => api(who, { idempotencyKey: key, command });
  const application = async (command: unknown, api = service) => {
    const result = applicationResultSchema.parse((await call(command, api)).body);
    expect(result.application).not.toBeNull(); return result.application!;
  };
  emptyIt('aloca 29 para 30 pendente e 31 no próximo lote sem bloquear registros', async () => {
    expect((await createReviewAreaService(first)(actor)).state).toBe('not_started');
    const early = save(); early.data.cycleRelation = 'after_reset';
    await expect(call(early)).rejects.toMatchObject({ status: 409, code: 'CYCLE_NOT_STARTED' });
    const start = { operation: 'start_cycle', clientId: randomUUID(), resetDate: unknownDate, resetMarker: null };
    const initialized = await createReviewService(first)(actor, { idempotencyKey: randomUUID(), command: start });
    expect(initialized.status).toBe(201);
    expect((await db.query('SELECT reset_date,is_current FROM career.cycles WHERE id=$1', [initialized.body.cycleId])).rows).toEqual([{ reset_date: unknownDate, is_current: true }]);
    await expect(reviewCall({ ...start, resetMarker: 'Corpo diferente.' })).rejects.toMatchObject({ status: 409 });
    expect((await createReviewService(second)(actor, { idempotencyKey: randomUUID(), command: start })).body.cycleId).toBe(initialized.body.cycleId);
    const apps = [];
    for (let i = 0; i < 29; i++) {
      const command = save(); command.data.cycleRelation = 'after_reset';
      apps.push(await application(command));
    }
    expect((await db.query("SELECT status FROM career.batches WHERE owner_id=$1", [owner])).rows).toEqual([{ status: 'open' }]);
    const c30 = save(); c30.data.cycleRelation = 'after_reset'; const c31 = save(); c31.data.cycleRelation = 'after_reset';
    apps.push(...(await Promise.all([application(c30), application(c31, createApplicationService(second))])).sort((a,b) => a.cycleOrder! - b.cycleOrder!));
    expect(apps.map((a) => a.cycleOrder)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    const batches = (await db.query('SELECT status FROM career.batches WHERE owner_id=$1 ORDER BY batch_number', [owner])).rows;
    expect(batches).toEqual([{ status: 'pending' }, { status: 'open' }]);
    const repeated = await application({ operation: 'confirm_submission', application: { id: apps[29]!.id, expectedVersion: apps[29]!.version }, submittedDate: unknownDate, cycleRelation: 'after_reset', evidence: evidence() });
    expect(repeated.cycleOrder).toBe(30);
    expect((await db.query('SELECT count(*)::int AS n FROM career.batch_members WHERE owner_id=$1', [owner])).rows[0].n).toBe(31);
    const historical = save(); historical.data.cycleRelation = 'before_reset';
    expect((await application(historical)).cycleOrder).toBeNull();
  }, 30_000);
  it('fecha revisão original de lote pendente com versão explícita', async () => {
    await seededBatch(30, false);
    const batch = (await db.query("SELECT id,version FROM career.batches WHERE owner_id=$1 AND status='pending'", [owner])).rows[0];
    const result = await createReviewService(first)(actor, { idempotencyKey: randomUUID(), command: { operation: 'close_review', batch: { id: batch.id, expectedVersion: batch.version }, narrative: 'Análise do proprietário.', decisions: ['Manter o CV enviado.'] } });
    expect(result.status).toBe(201);
    const original = await latest(batch.id);
    expect(reviewSnapshotSchema.parse(original.snapshot)).toEqual(original.snapshot);
    // A confirmação repetida acrescenta uma nota com evidência, sem outro envio.
    expect(original.snapshot.eventEvidence.map((item: { eventId: string }) => item.eventId).sort()).toEqual([...original.event_ids].sort());
  }, 30_000);

  const reviewCall = (command: unknown, database = first) => createReviewService(database)(actor, { idempotencyKey: randomUUID(), command });
  const latest = async (batch: string) => (await db.query('SELECT * FROM career.review_versions WHERE batch_id=$1 ORDER BY version_number DESC LIMIT 1', [batch])).rows[0]!;
  const batchRef = async (id: string) => ({ id, expectedVersion: (await db.query('SELECT version FROM career.batches WHERE id=$1', [id])).rows[0].version as number });
  const eventData = (kind = 'retorno_substantivo') => ({ kind, state: 'informado', occurredDate: day('2026-11-15'), resultText: 'Resultado fictício.', scoreValue: null, scoreUnit: null, sourceText: null, evidence: null });
  const appRef = async (id: string) => ({ id, expectedVersion: (await db.query('SELECT version FROM career.applications WHERE id=$1', [id])).rows[0].version as number });
  it('resultado posterior e retificação preservam original byte a byte e denominador corrigido', async () => {
    await seededBatch(30);
    const batch = (await db.query("SELECT id FROM career.batches WHERE owner_id=$1 AND status='closed'", [owner])).rows[0].id as string;
    const original = await latest(batch); const app = original.population_ids[0] as string;
    expect(original.snapshot.metrics.response.denominator).toBe(30);
    await createActivityService(second)(actor, { idempotencyKey: randomUUID(), command: { operation: 'record_event', clientId: randomUUID(), application: await appRef(app), data: eventData() } });
    const view = await createReviewReadService(first)(actor, batch);
    expect(view.laterResults).toHaveLength(1); expect(view.version.snapshot).toEqual(original.snapshot);
    const corrected = await call({ operation: 'invalidate_submission', application: await appRef(app), affectedBatches: [await batchRef(batch)], reason: 'Envio inválido comprovado.', evidence: evidence() });
    expect(corrected.body.affectedBatches[0]?.rectificationPending).toBe(true);
    const membersBefore = (await db.query('SELECT * FROM career.batch_members WHERE batch_id=$1 ORDER BY id', [batch])).rows;
    const ref = await batchRef(batch);
    const command = { operation: 'revise_review', batch: ref, predecessorId: original.id, type: 'rectification', narrative: 'Retificação explícita.', decisions: ['Denominador corrigido.'], reason: 'Evidência posterior.', evidence: evidence() };
    const revised = await reviewCall(command);
    expect(revised.body.versionNumber).toBe(2);
    const current = await latest(batch);
    expect(current.predecessor_id).toBe(original.id); expect(current.population_ids).toEqual(original.population_ids);
    expect(current.snapshot.metrics.response.denominator).toBe(29);
    expect(current.snapshot.eligiblePopulationIds).not.toContain(app);
    expect((await db.query('SELECT * FROM career.review_versions WHERE id=$1', [original.id])).rows[0]).toEqual(original);
    expect((await db.query('SELECT * FROM career.batch_members WHERE batch_id=$1 ORDER BY id', [batch])).rows).toEqual(membersBefore);
    expect((await db.query('SELECT rectification_pending FROM career.batches WHERE id=$1', [batch])).rows[0].rectification_pending).toBe(false);
    await expect(reviewCall(command)).rejects.toMatchObject({ status: 409 });
    const next = { ...command, batch: await batchRef(batch), predecessorId: current.id, type: 'revision', evidence: evidence() };
    const results = await Promise.allSettled([reviewCall(next), reviewCall(next, second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await latest(batch)).snapshot).toEqual(current.snapshot);
  }, 30_000);
  it('nega início por agente e não adota ciclo existente nem clientId alterado', async () => {
    const command = { operation: 'start_cycle', clientId: randomUUID(), resetDate: unknownDate, resetMarker: null };
    await expect(createReviewService(first)(actorAgain, { idempotencyKey: randomUUID(), command })).rejects.toMatchObject({ status: 403 });
    await expect(reviewCall(command)).rejects.toMatchObject({ status: 409, code: 'CYCLE_CONFIGURATION' });
  });
  it('rollback após gravar revisão reverte versão, auditoria e resposta', async () => {
    await seededBatch();
    const batch = (await db.query("SELECT id FROM career.batches WHERE owner_id=$1 AND status='closed'", [owner])).rows[0].id as string;
    const previous = await latest(batch); const before = (await db.query('SELECT * FROM career.batches WHERE id=$1', [batch])).rows;
    const audit = (await db.query('SELECT count(*)::int AS n FROM career.audit_log WHERE owner_id=$1', [owner])).rows;
    const intercepted = intercept(first, (sql) => sql.startsWith('INSERT INTO career.review_versions'), async () => { throw new Error('Falha sintética.'); });
    await expect(reviewCall({ operation: 'revise_review', batch: await batchRef(batch), predecessorId: previous.id, type: 'revision', narrative: null, decisions: [], reason: 'Revisão.', evidence: evidence() }, intercepted)).rejects.toMatchObject({ status: 503 });
    expect(await latest(batch)).toEqual(previous); expect((await db.query('SELECT * FROM career.batches WHERE id=$1', [batch])).rows).toEqual(before);
    expect((await db.query('SELECT count(*)::int AS n FROM career.audit_log WHERE owner_id=$1', [owner])).rows).toEqual(audit);
  });
  function intercept(database: typeof first, predicate: (sql: string) => boolean, after: () => Promise<void>) {
    let done = false;
    return { ...database, transaction<T>(who: typeof actor, work: (tx: AuthenticatedTransaction) => Promise<T>, context?: RequestContext) {
      return database.transaction(who, (tx) => work({ ...tx, query: async <Row extends pg.QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await tx.query<Row>(sql, values); if (!done && predicate(sql)) { done = true; await after(); } return result;
      } }), context);
    } };
  }

  it('fechamento conserva projeção única enquanto atividade corrige evento concorrente', async () => {
    const command = save(); command.data.cycleRelation = 'after_reset'; const app = await application(command);
    const batch = (await db.query('SELECT batch_id FROM career.batch_members WHERE application_id=$1', [app.id])).rows[0].batch_id as string;
    const originalEvent = await createActivityService(first)(actor, { idempotencyKey: randomUUID(), command: { operation: 'record_event', clientId: randomUUID(), application: await appRef(app.id), data: eventData() } });
    const n = (await db.query('SELECT count(*)::int AS n FROM career.batch_members WHERE batch_id=$1 AND eligible', [batch])).rows[0].n;
    // Apenas reduz a meta da fixture; todos os dados/ciclo foram criados pelo runtime suportado.
    await db.query("UPDATE career.batches SET target=$2,status='pending' WHERE id=$1", [batch, n]);
    let enter!: () => void; let release!: () => void; const entered = new Promise<void>((r) => { enter = r; }); const held = new Promise<void>((r) => { release = r; });
    const intercepted = intercept(first, (sql) => sql.startsWith('SELECT jsonb_build_object('), async () => { enter(); await held; });
    const close = reviewCall({ operation: 'close_review', batch: await batchRef(batch), narrative: null, decisions: [] }, intercepted);
    await entered;
    let replacement: Awaited<ReturnType<ReturnType<typeof createActivityService>>>;
    try {
      replacement = await createActivityService(second)(actor, { idempotencyKey: randomUUID(), command: { operation: 'correct_event', clientId: randomUUID(), application: await appRef(app.id), eventId: originalEvent.body.event!.id, replacement: { ...eventData(), state: 'concluido', resultText: 'Interpretação corrigida.' }, reason: 'Correção explícita.', evidence: evidence() } });
    } finally { release(); }
    await close;
    const original = await latest(batch);
    expect(original.event_ids).toContain(originalEvent.body.event!.id); expect(original.event_ids).not.toContain(replacement!.body.event!.id);
    expect(original.snapshot.events.find((e: {id: string}) => e.id === originalEvent.body.event!.id).resultText).toBe('Resultado fictício.');
    expect(original.snapshot.applications.find((a: {id: string}) => a.id === app.id).version).toBe(app.version + 1);
    expect((await createReviewReadService(first)(actor, batch)).laterResults.map((e) => e.id)).toContain(replacement!.body.event!.id);
    await reviewCall({ operation: 'revise_review', batch: await batchRef(batch), predecessorId: original.id, type: 'rectification', narrative: null, decisions: [], reason: 'Recalcular interpretação corrigida.', evidence: evidence() });
    expect((await latest(batch)).snapshot.eventIds).toContain(replacement!.body.event!.id);
    expect((await db.query('SELECT * FROM career.review_versions WHERE id=$1', [original.id])).rows[0]).toEqual(original);
  });
  it('inserção direta em lote fechado rejeita flag falsa de restauração', async () => {
    await seededBatch();
    const command = save(); command.data.cycleRelation = 'before_reset'; const app = await application(command);
    const batch = (await db.query("SELECT id FROM career.batches WHERE owner_id=$1 AND status='closed' ORDER BY batch_number LIMIT 1", [owner])).rows[0].id;
    await expect(first.transaction(actor, async (tx) => {
      await tx.query("UPDATE career.applications SET cycle_relation='after_reset' WHERE id=$1", [app.id]);
      await tx.query("SELECT set_config('app.restore','true',true),set_config('app.restore_run_id',$1,true)", [randomUUID()]);
      await tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,999)', [owner, batch, app.id]);
    })).rejects.toMatchObject({ code: '23514' });
    expect((await db.query('SELECT id FROM career.batch_members WHERE application_id=$1', [app.id])).rowCount).toBe(0);
  });
  it('correção aberta libera vaga sem mover membros nem reutilizar ordem preservada', async () => {
    const cmd = save(); cmd.data.cycleRelation = 'after_reset'; const app = await application(cmd);
    const batch = (await db.query('SELECT batch_id FROM career.batch_members WHERE application_id=$1', [app.id])).rows[0].batch_id as string;
    await call({ operation: 'invalidate_submission', application: await appRef(app.id), affectedBatches: [await batchRef(batch)], reason: 'Excluir envio inválido.', evidence: evidence() });
    const next = save(); next.data.cycleRelation = 'after_reset'; const replacement = await application(next);
    expect(replacement.cycleOrder).toBe(app.cycleOrder! + 1);
    expect((await db.query('SELECT batch_id FROM career.batch_members WHERE application_id=$1', [replacement.id])).rows[0].batch_id).toBe(batch);
    expect((await db.query('SELECT captured_order,eligible FROM career.batch_members WHERE application_id=$1', [app.id])).rows).toEqual([{ captured_order: String(app.cycleOrder), eligible: false }]);
  });

  async function directFixture(target = 1) {
    const members = [];
    for (let i = 0; i < 2; i++) {
      const command = save(); command.data.cycleRelation = 'before_reset'; const app = await application(command);
      await first.transaction(actor, (tx) => tx.query("UPDATE career.applications SET cycle_relation='after_reset' WHERE id=$1", [app.id])); members.push(app.id);
    }
    const batch = await first.transaction(actor, async (tx) => {
      const cycle = (await tx.query('SELECT id FROM career.cycles WHERE owner_id=$1 AND is_current', [owner])).rows[0]!.id;
      return (await tx.query(`INSERT INTO career.batches(owner_id,cycle_id,batch_number,target,status) SELECT $1,$2,coalesce(max(batch_number),0)+1,$3,'pending' FROM career.batches WHERE owner_id=$1 AND cycle_id=$2 RETURNING id`, [owner, cycle, target])).rows[0]!.id as string;
    });
    return { batch, members: members as [string,string] };
  }
  it('guard direto espera candidatura antes do lote e revalida elegibilidade', async () => {
    const { batch, members: [app] } = await directFixture();
    let enter!: () => void; let release!: () => void; const entered = new Promise<void>((r) => { enter = r; }); const held = new Promise<void>((r) => { release = r; });
    const blocker = first.transaction(actor, async (tx) => { await tx.query('SELECT id FROM career.applications WHERE id=$1 FOR UPDATE', [app]); enter(); await held; await tx.query('UPDATE career.applications SET counting_eligible=false WHERE id=$1', [app]); });
    await entered;
    const insert = second.transaction(actor, (tx) => tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,900001)', [owner, batch, app]));
    const rejected = expect(insert).rejects.toMatchObject({ code: '23514' });
    try {
      await vi.waitFor(async () => { expect((await db.query("SELECT pid FROM pg_stat_activity WHERE usename='career_api' AND query LIKE 'INSERT INTO career.batch_members%' AND cardinality(pg_blocking_pids(pid))>0")).rowCount).toBeGreaterThan(0); });
      await db.query('BEGIN'); await db.query('SELECT id FROM career.batches WHERE id=$1 FOR UPDATE NOWAIT', [batch]); await db.query('ROLLBACK');
    } finally { release(); }
    await blocker; await rejected;
    expect((await db.query('SELECT id FROM career.batch_members WHERE batch_id=$1', [batch])).rowCount).toBe(0);
    // Não deixar uma fixture pendente vazia no caminho da alocação.
    await db.query("UPDATE career.batches SET status='closed' WHERE id=$1", [batch]);
  });
  it('INSERT vencedor entra no snapshot; fechamento vencedor rejeita INSERT concorrente', async () => {
    const before = await directFixture(2); const [a,b] = before.members;
    await first.transaction(actor, (tx) => tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,900002)', [owner, before.batch, a]));
    let enter!: () => void; let release!: () => void; const entered = new Promise<void>((r) => { enter = r; }); const held = new Promise<void>((r) => { release = r; });
    const insertion = second.transaction(actor, async (tx) => { await tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,900003)', [owner, before.batch, b]); enter(); await held; });
    await entered;
    const closing = reviewCall({ operation: 'close_review', batch: await batchRef(before.batch), narrative: null, decisions: [] });
    release(); await insertion; await closing;
    expect(new Set((await latest(before.batch)).population_ids)).toEqual(new Set([a,b]));
    const after = await directFixture();
    await first.transaction(actor, (tx) => tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,900004)', [owner, after.batch, after.members[0]]));
    let freeze!: () => void; let resume!: () => void; const frozen = new Promise<void>((r) => { freeze = r; }); const waiting = new Promise<void>((r) => { resume = r; });
    const close = reviewCall({ operation: 'close_review', batch: await batchRef(after.batch), narrative: null, decisions: [] }, intercept(first, (sql) => sql.startsWith('SELECT jsonb_build_object('), async () => { freeze(); await waiting; }));
    await frozen;
    const insert = second.transaction(actor, (tx) => tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,900005)', [owner, after.batch, after.members[1]]));
    const rejected = expect(insert).rejects.toMatchObject({ code: '23514' });
    resume(); await close; await rejected;
    expect((await latest(after.batch)).population_ids).toEqual([after.members[0]]);
  });

  it('retifica duplicata fechada com vencedor externo preservando 30 IDs e histórico do alias', async () => {
    const fixture = await directFixture(30); const ids = [...fixture.members];
    for (let i = 2; i < 30; i++) {
      const command = save(); command.data.cycleRelation = 'before_reset'; const app = await application(command); ids.push(app.id);
      await first.transaction(actor, (tx) => tx.query("UPDATE career.applications SET cycle_relation='after_reset' WHERE id=$1", [app.id]));
    }
    await first.transaction(actor, async (tx) => {
      for (let i = 0; i < ids.length; i++) await tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,$4)', [owner, fixture.batch, ids[i], 910000+i]);
    });
    await reviewCall({ operation: 'close_review', batch: await batchRef(fixture.batch), narrative: 'Original.', decisions: [] });
    const original = await latest(fixture.batch); const winner = await application(save()); const alias = ids[0]!;
    const aliasEvents = (await db.query('SELECT id FROM career.events WHERE application_id=$1', [alias])).rows.map((e) => e.id);
    await call({ operation: 'resolve_duplicate', application: await appRef(alias), canonicalApplication: await appRef(winner.id), affectedBatches: [await batchRef(fixture.batch)], reason: 'Duplicata verificada.', evidence: evidence() });
    await reviewCall({ operation: 'revise_review', batch: await batchRef(fixture.batch), predecessorId: original.id, type: 'rectification', narrative: 'Contagem corrigida.', decisions: [], reason: 'Vencedor fora do lote.', evidence: evidence() });
    const current = await latest(fixture.batch);
    expect(current.population_ids).toHaveLength(30); expect(current.population_ids).toEqual(original.population_ids);
    expect(current.snapshot.metrics.response.denominator).toBe(29);
    expect(current.snapshot.eligiblePopulationIds).not.toContain(winner.id);
    expect(current.snapshot.relatedCanonicalApplications.map((a: {id: string}) => a.id)).toContain(winner.id);
    expect(current.snapshot.applications.find((a: {id: string}) => a.id === alias).canonicalApplicationId).toBe(winner.id);
    expect(current.snapshot.eventIds).toEqual(expect.arrayContaining(aliasEvents));
    expect((await db.query('SELECT * FROM career.review_versions WHERE id=$1', [original.id])).rows[0]).toEqual(original);
  }, 30_000);
  it('candidato de alocação alterado enquanto espera retorna conflito sem lock inverso ou escrita parcial', async () => {
    await seededBatch(1, false);
    const before = save(); before.data.cycleRelation = 'before_reset'; const extra = await application(before);
    await first.transaction(actor, (tx) => tx.query("UPDATE career.applications SET cycle_relation='after_reset' WHERE id=$1", [extra.id]));
    const batch = (await db.query("SELECT b.id,(SELECT count(*)::int FROM career.batch_members m WHERE m.batch_id=b.id AND m.eligible AND m.allocation='counted') AS n FROM career.batches b WHERE owner_id=$1 AND status<>'closed' ORDER BY batch_number LIMIT 1", [owner])).rows[0];
    await db.query("UPDATE career.batches SET target=$2,status='open' WHERE id=$1", [batch.id, batch.n+1]);
    let enter!: () => void; let release!: () => void; const entered = new Promise<void>((r) => { enter = r; }); const held = new Promise<void>((r) => { release = r; });
    const intercepted = intercept(first, (sql) => sql.startsWith('SELECT b.id FROM career.batches'), async () => { enter(); await held; });
    const command = save(); command.data.cycleRelation = 'after_reset';
    const allocation = call(command, createApplicationService(intercepted)); const rejected = expect(allocation).rejects.toMatchObject({ status: 409 });
    await entered;
    try {
      await second.transaction(actor, async (tx) => { await tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,920000)', [owner, batch.id, extra.id]); await tx.query("UPDATE career.batches SET status='pending',version=version+1 WHERE id=$1", [batch.id]); });
      await reviewCall({ operation: 'close_review', batch: await batchRef(batch.id), narrative: null, decisions: [] }, second);
    } finally { release(); }
    await rejected;
    expect((await db.query("SELECT id FROM career.creation_requests WHERE owner_id=$1 AND client_id=$2", [owner, command.clientId])).rowCount).toBe(0);
  });

  it('correção que espera fechamento obsoleto conflita; nova tentativa marca retificação', async () => {
    const fixture = await directFixture(); const app = fixture.members[0];
    await first.transaction(actor, (tx) => tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,930000)', [owner, fixture.batch, app]));
    const oldRef = await batchRef(fixture.batch);
    let enter!: () => void; let release!: () => void; const entered = new Promise<void>((r) => { enter = r; }); const held = new Promise<void>((r) => { release = r; });
    const close = reviewCall({ operation: 'close_review', batch: oldRef, narrative: null, decisions: [] }, intercept(first, (sql) => sql.startsWith('SELECT jsonb_build_object('), async () => { enter(); await held; }));
    await entered;
    const command = { operation: 'invalidate_submission', application: await appRef(app), affectedBatches: [oldRef], reason: 'Evidência posterior.', evidence: evidence() };
    const correction = call(command, createApplicationService(second)); const rejected = expect(correction).rejects.toMatchObject({ status: 409 });
    release(); await close; await rejected;
    const original = await latest(fixture.batch);
    const result = await call({ ...command, affectedBatches: [await batchRef(fixture.batch)] });
    expect(result.body.affectedBatches[0]?.rectificationPending).toBe(true);
    expect((await db.query('SELECT * FROM career.review_versions WHERE id=$1', [original.id])).rows[0]).toEqual(original);
  });
  it('falha após alocação reverte ordens, membros, versões, identidade e auditoria', async () => {
    const inventory = async () => (await db.query(`SELECT
      (SELECT count(*) FROM career.applications WHERE owner_id=$1)::int AS applications,
      (SELECT count(*) FROM career.batch_members WHERE owner_id=$1)::int AS members,
      (SELECT count(*) FROM career.batches WHERE owner_id=$1)::int AS batches,
      (SELECT count(*) FROM career.creation_requests WHERE owner_id=$1)::int AS mappings,
      (SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audits,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM career.cycles c WHERE owner_id=$1) AS cycles`, [owner])).rows[0];
    const before = await inventory(); const command = save(); command.data.cycleRelation = 'after_reset';
    const intercepted = intercept(first, (sql) => sql.startsWith('UPDATE career.cycles SET next_order'), async () => { throw new Error('Falha após contador.'); });
    await expect(call(command, createApplicationService(intercepted))).rejects.toMatchObject({ status: 503 });
    expect(await inventory()).toEqual(before);
  });
  it('não escolhe ciclo sem marcador explícito e avança acima de ordem preservada', async () => {
    const current = (await db.query('SELECT id FROM career.cycles WHERE owner_id=$1 AND is_current', [owner])).rows[0].id;
    await first.transaction(actor, (tx) => tx.query('UPDATE career.cycles SET is_current=false WHERE id=$1', [current]));
    try {
      expect((await application(save())).cycleOrder).toBeNull();
      const command = save(); command.data.cycleRelation = 'after_reset';
      await expect(call(command)).rejects.toMatchObject({ status: 409, code: 'CYCLE_CONFIGURATION' });
      await expect(createReviewAreaService(first)(actor)).rejects.toMatchObject({ code: 'CYCLE_CONFIGURATION' });
    } finally { await first.transaction(actor, (tx) => tx.query('UPDATE career.cycles SET is_current=true WHERE id=$1', [current])); }
    const preserved = await application(save());
    await first.transaction(actor, (tx) => tx.query('UPDATE career.applications SET cycle_order=1200 WHERE id=$1', [preserved.id]));
    const command = save(); command.data.cycleRelation = 'after_reset';
    expect((await application(command)).cycleOrder).toBe(1201);
    expect((await db.query('SELECT cycle_order FROM career.applications WHERE id=$1', [preserved.id])).rows[0].cycle_order).toBe('1200');
  });
  it('preserva Markdown histórico, cálculo v1, proveniência e fechamento desconhecido em revisão textual', async () => {
    const fixture = await directFixture(); const app = fixture.members[0]; const originalId = randomUUID();
    const markdown = '# Revisão histórica\n\nTexto original, sem normalização.\n'; const provenance = { file: 'revisao-ficticia.md', row: 7 };
    await first.transaction(actor, async (tx) => {
      await tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,940000)', [owner, fixture.batch, app]);
      await tx.query('SELECT id FROM career.batches WHERE id=$1 FOR UPDATE', [fixture.batch]);
      const projection = await loadReviewProjection(tx, owner, fixture.batch);
      const snapshot = { ...buildReviewSnapshot(projection.rows, projection.events, projection.populationIds, projection.asOf), calculationVersion: 'metrics-v1/review-v1' };
      await tx.query("INSERT INTO career.review_versions(id,owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids,original_markdown,import_provenance,calculation_version) VALUES($1,$2,$3,1,'original',$4,$5,$6,$7,$8,$9)", [originalId, owner, fixture.batch, snapshot, [app], snapshot.eventIds, markdown, provenance, snapshot.calculationVersion]);
      await tx.query("UPDATE career.batches SET status='closed' WHERE id=$1", [fixture.batch]);
    });
    const original = await latest(fixture.batch);
    await reviewCall({ operation: 'revise_review', batch: await batchRef(fixture.batch), predecessorId: originalId, type: 'revision', narrative: 'Novo comentário.', decisions: [], reason: 'Revisão de texto.', evidence: evidence() });
    const current = await latest(fixture.batch);
    expect(current.original_markdown).toBe(markdown); expect(current.import_provenance).toEqual(provenance); expect(current.closed_at).toBeNull();
    expect(current.calculation_version).toBe('metrics-v1/review-v1');
    expect(current.snapshot).toEqual(original.snapshot);
    expect((await db.query('SELECT * FROM career.review_versions WHERE id=$1', [originalId])).rows[0]).toEqual(original);
  });
  it('alocação usa meta persistida abaixo de 30 e permite fechar ao completar dois membros', async () => {
    await seededBatch(1, false);
    const candidate = (await db.query("SELECT b.id,(SELECT count(*)::int FROM career.batch_members m WHERE m.batch_id=b.id AND m.eligible AND m.allocation='counted') AS n FROM career.batches b WHERE owner_id=$1 AND status<>'closed' ORDER BY batch_number LIMIT 1", [owner])).rows[0];
    expect(candidate.n).toBe(1);
    await first.transaction(actor, (tx) => tx.query('UPDATE career.batches SET target=2 WHERE id=$1', [candidate.id]));
    const command = save(); command.data.cycleRelation = 'after_reset'; await application(command);
    expect((await db.query('SELECT status,target FROM career.batches WHERE id=$1', [candidate.id])).rows[0]).toEqual({ status: 'pending', target: 2 });
    await reviewCall({ operation: 'close_review', batch: await batchRef(candidate.id), narrative: null, decisions: [] });
    expect((await latest(candidate.id)).snapshot.metrics.response.denominator).toBe(2);
  });
  it('alocação mantém aberta meta 31 com 30 membros e fecha somente ao completar 31', async () => {
    const command = save(); command.data.cycleRelation = 'after_reset'; const app = await application(command);
    const batch = (await db.query('SELECT batch_id FROM career.batch_members WHERE application_id=$1', [app.id])).rows[0].batch_id;
    await first.transaction(actor, (tx) => tx.query('UPDATE career.batches SET target=31 WHERE id=$1', [batch]));
    const initial = (await db.query("SELECT count(*)::int AS n FROM career.batch_members WHERE batch_id=$1 AND eligible AND allocation='counted'", [batch])).rows[0].n;
    for (let n = initial; n < 30; n++) { const next = save(); next.data.cycleRelation = 'after_reset'; await application(next); }
    expect((await db.query('SELECT status FROM career.batches WHERE id=$1', [batch])).rows[0].status).toBe('open');
    await expect(reviewCall({ operation: 'close_review', batch: await batchRef(batch), narrative: null, decisions: [] })).rejects.toMatchObject({ status: 409 });
    const last = save(); last.data.cycleRelation = 'after_reset'; await application(last);
    expect((await db.query('SELECT status FROM career.batches WHERE id=$1', [batch])).rows[0].status).toBe('pending');
    await reviewCall({ operation: 'close_review', batch: await batchRef(batch), narrative: null, decisions: [] });
    expect((await latest(batch)).snapshot.metrics.response.denominator).toBe(31);
  }, 30_000);
  it('retificação explícita recupera membro capturado excluído sem alterar histórico ou incluir externos', async () => {
    const fixture = await directFixture(2); const ids = [...fixture.members];
    const extra = save(); extra.data.cycleRelation = 'before_reset'; const third = await application(extra); ids.push(third.id);
    await first.transaction(actor, async (tx) => {
      await tx.query("UPDATE career.applications SET cycle_relation='after_reset' WHERE id=$1", [third.id]);
      for (let i = 0; i < ids.length; i++) await tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,$4)', [owner, fixture.batch, ids[i], 960000+i]);
    });
    await call({ operation: 'update_application', application: await appRef(third.id), changes: {}, reconciliation: { submittedDate: unknownDate, cycleRelation: 'before_reset' }, affectedBatches: [await batchRef(fixture.batch)], evidence: evidence() });
    await reviewCall({ operation: 'close_review', batch: await batchRef(fixture.batch), narrative: 'Original com membro excluído.', decisions: [] });
    const original = await latest(fixture.batch);
    expect(original.population_ids).toHaveLength(3); expect(original.snapshot.metrics.response.denominator).toBe(2);
    const physical = (await db.query('SELECT * FROM career.batch_members WHERE batch_id=$1 ORDER BY id', [fixture.batch])).rows;
    expect(physical.find((member) => member.application_id === third.id).eligible).toBe(false);
    const outside = save(); outside.data.cycleRelation = 'after_reset'; const outsider = await application(outside);
    await call({ operation: 'update_application', application: await appRef(third.id), changes: {}, reconciliation: { submittedDate: unknownDate, cycleRelation: 'after_reset' }, affectedBatches: [await batchRef(fixture.batch)], evidence: evidence() });
    await reviewCall({ operation: 'revise_review', batch: await batchRef(fixture.batch), predecessorId: original.id, type: 'rectification', narrative: 'Elegibilidade restaurada explicitamente.', decisions: [], reason: 'Envio pertence ao ciclo.', evidence: evidence() });
    const current = await latest(fixture.batch);
    expect(current.snapshot.metrics.response.denominator).toBe(3);
    expect(new Set(current.snapshot.eligiblePopulationIds)).toEqual(new Set(ids));
    expect(current.population_ids).toEqual(original.population_ids); expect(current.snapshot.eligiblePopulationIds).not.toContain(outsider.id);
    expect((await db.query('SELECT * FROM career.batch_members WHERE batch_id=$1 ORDER BY id', [fixture.batch])).rows).toEqual(physical);
    expect((await db.query('SELECT * FROM career.review_versions WHERE id=$1', [original.id])).rows[0]).toEqual(original);
  });
  it('exceção histórica exige login real de restore e execução persistida ativa', async () => {
    await seededBatch();
    const app = await application(save());
    const batch = (await db.query("SELECT id FROM career.batches WHERE owner_id=$1 AND status='closed' ORDER BY batch_number LIMIT 1", [owner])).rows[0].id;
    const restore = new pg.Client({ connectionString: restoreUrl, ssl: false }); const run = randomUUID(); const hash = 'c'.repeat(64);
    await restore.connect();
    try {
      expect((await restore.query('SELECT session_user,current_user')).rows[0]).toEqual({ session_user: 'career_restore', current_user: 'career_restore' });
      await restore.query('BEGIN');
      await restore.query("SELECT set_config('app.restore_run_id',$1,true),set_config('app.restore','true',true)", [run]);
      await expectSqlState(restore, 'INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,950000)', [owner, batch, app.id], '23514');
      await db.query("INSERT INTO career.restore_runs(id,owner_id,destination_owner_id,manifest_hash,format_version,expected_rows,state) VALUES($1,$2,$2,$3,1,1,'restoring')", [run, owner, hash]);
      await db.query("UPDATE career.maintenance_state SET state='restoring',active_restore_run_id=$1,manifest_hash=$2 WHERE owner_id=$3", [run, hash, owner]);
      await expect(first.assertReady()).rejects.toMatchObject({ code: 'MAINTENANCE' });
      const row = await restore.query("INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order,created_at,updated_at) VALUES($1,$2,$3,950000,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z') RETURNING created_at", [owner, batch, app.id]);
      expect(row.rows[0].created_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    } finally {
      await restore.query('ROLLBACK'); await restore.end();
      await db.query("UPDATE career.maintenance_state SET state='ready',active_restore_run_id=NULL,manifest_hash=NULL WHERE owner_id=$1", [owner]);
      await db.query('DELETE FROM career.restore_runs WHERE owner_id=$1 AND id=$2', [owner, run]);
    }
  });
});
