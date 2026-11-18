import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, expectSqlState } from '../helpers/database';
import { z } from 'zod';
import { createDatabase } from '../../server/database';
import { createMutation } from '../../server/mutation';
import { authenticateBearer } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { provisionOwner } from '../../scripts/provision-owner';
import { createSafeLogger } from '../../server/logger';

let db: pg.Client;
const owner = '00000000-0000-4000-8000-000000000001';
const otherOwner = '00000000-0000-4000-8000-000000000002';
beforeAll(async () => { db = await connectTestDatabase(); });
afterAll(async () => { await db?.end(); });
beforeEach(async () => { await db.query('BEGIN'); });
afterEach(async () => { await db.query('ROLLBACK'); });

async function opportunity(ownerId = owner): Promise<string> {
  const id = randomUUID();
  await db.query('INSERT INTO career.opportunities (id, owner_id) VALUES ($1,$2)', [id, ownerId]);
  return id;
}
async function application(opportunityId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = { id: randomUUID(), owner_id: owner, opportunity_id: opportunityId, ...overrides };
  const columns = Object.keys(row);
  await db.query(`INSERT INTO career.applications (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
  return row.id;
}

describe('restrições persistentes de candidaturas', () => {
  it('confirma conexão real e exige o modelo instalado', async () => {
    expect((await db.query('SELECT 1 AS connected')).rows[0].connected).toBe(1);
    expect((await db.query("SELECT to_regclass('career.applications')::text AS model")).rows[0].model).toBe('career.applications');
  });
  it('rejeita UUID e legacy_id duplicados', async () => {
    const opportunityId = await opportunity();
    const id = await application(opportunityId, { legacy_id: 'V123', display_id: 'V123' });
    await expectSqlState(db, 'INSERT INTO career.applications (id,owner_id,opportunity_id) VALUES ($1,$2,$3)', [id, owner, opportunityId], '23505');
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,legacy_id,display_id,application_instance) VALUES ($1,$2,$3,$4,$5)', [owner, opportunityId, 'V123', 'V123', 'second'], '23505');
  });
  it('aceita somente os três estados de envio', async () => {
    const opportunityId = await opportunity();
    for (const status of ['confirmado', 'nao_confirmado', 'nao_enviado']) {
      await application(opportunityId, { submission_status: status, application_instance: status });
    }
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,submission_status) VALUES ($1,$2,$3)', [owner, opportunityId, 'enviado'], '23514');
  });
  it('rejeita vínculo entre proprietários', async () => {
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id) VALUES ($1,$2)', [owner, await opportunity(otherOwner)], '23503');
  });
  it('rejeita versão não positiva', async () => {
    await expectSqlState(db, 'INSERT INTO career.opportunities (owner_id,version) VALUES ($1,0)', [owner], '23514');
  });
  it('preserva fatos desconhecidos e datas sem conversão de fuso', async () => {
    const opportunityId = await opportunity();
    const id = await application(opportunityId);
    const app = (await db.query('SELECT * FROM career.applications WHERE id=$1', [id])).rows[0];
    const opp = (await db.query('SELECT * FROM career.opportunities WHERE id=$1', [opportunityId])).rows[0];
    expect(opp.company).toBeNull();
    expect(opp.title).toBeNull();
    expect(app.submitted_date).toEqual({ precision: 'unknown', value: null });
    expect(app.legacy_registered_date).toEqual({ precision: 'unknown', value: null });
    expect(app.cycle_order).toBeNull();
    expect(app.display_id).toMatch(/^N\d{6,}$/);
    const date = { precision: 'day', certainty: 'exact', value: '2026-11-10' };
    await db.query('UPDATE career.applications SET submitted_date=$2 WHERE id=$1', [id, date]);
    expect((await db.query('SELECT submitted_date FROM career.applications WHERE id=$1', [id])).rows[0].submitted_date).toEqual(date);
  });
  it.each([
    { precision: 'day', certainty: 'exact', value: '2026-02-29' },
    { precision: 'day', certainty: 'exact', value: '2026-04-31' },
    { precision: 'month', certainty: 'exact', value: '2026-13' },
    { precision: 'year', certainty: 'exact', value: '0000' },
    { precision: 'instant', certainty: 'exact', value: '2026-11-10T25:00:00Z' },
    { precision: 'instant', certainty: 'exact', value: '2026-11-10T12:00:00' },
    { precision: 'unknown', value: '2026' },
    { precision: 'unknown', value: null, ownerId: owner },
    { precision: 'day', value: '2026-11-10' },
  ])('recusa DateValue inválido %j', async (date) => {
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,submitted_date) VALUES ($1,$2,$3)', [owner, await opportunity(), date], '23514');
  });
  it('impede duplicação canônica, inclusive arquivada e track desconhecido', async () => {
    const opp = await opportunity();
    const app = await application(opp);
    await db.query('UPDATE career.applications SET archived_at=now() WHERE id=$1', [app]);
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,track) VALUES ($1,$2,$3)', [owner, opp, null], '23505');
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,track) VALUES ($1,$2,$3)', [owner, opp, '   '], '23505');
    await application(opp, { track: 'Backend' });
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,track) VALUES ($1,$2,$3)', [owner, opp, ' Backend '], '23505');
    await application(opp, { track: 'backend' });
    await application(opp, { application_instance: 'segunda_ocorrencia' });
    await application(opp, { canonical_application_id: app });
  });
  it('identidade forte é única e preserva case de job code/path', async () => {
    const one = await opportunity();
    const two = await opportunity();
    const insert = 'INSERT INTO career.opportunity_identities (owner_id,opportunity_id,provider,tenant,identity_kind,identity_value) VALUES ($1,$2,$3,$4,$5,$6)';
    await db.query(insert, [owner, one, 'gupy', 'tenant', 'job_code', 'AbC/42']);
    await expectSqlState(db, insert, [owner, two, ' GUPY ', 'tenant', 'job_code', 'AbC/42'], '23505');
    await db.query(insert, [owner, two, 'gupy', 'tenant', 'job_code', 'abc/42']);
    await expectSqlState(db, insert, [owner, two, '', '', 'job_code', ''], '23514');
  });
  it('identificadores fortes declarados na oportunidade não contornam o registro único', async () => {
    const one = (await db.query('INSERT INTO career.opportunities (owner_id,platform,tenant,job_code) VALUES ($1,$2,$3,$4) RETURNING id', [owner, 'portal', 'empresa', 'JOB42'])).rows[0].id;
    const two = await opportunity();
    await expectSqlState(db, 'INSERT INTO career.opportunities (owner_id,platform,tenant,job_code) VALUES ($1,$2,$3,$4)', [owner, ' PORTAL ', 'empresa', 'JOB42'], '23505');
    await expectSqlState(db, 'INSERT INTO career.opportunity_identities (owner_id,opportunity_id,provider,tenant,identity_kind,identity_value) VALUES ($1,$2,$3,$4,$5,$6)', [owner, two, 'portal', 'empresa', 'job_code', 'JOB42'], '23505');
    expect((await db.query('SELECT opportunity_id FROM career.opportunity_identities WHERE opportunity_id=$1', [one])).rowCount).toBe(1);
  });
  it('tenant ausente permanece identidade não resolvida; namespaces explícitos são distintos', async () => {
    const insert = 'INSERT INTO career.opportunities (owner_id,platform,tenant,job_code) VALUES ($1,$2,$3,$4) RETURNING id';
    const one = (await db.query(insert, [owner, 'portal', null, 'JOB42'])).rows[0].id;
    const two = (await db.query(insert, [owner, 'portal', null, 'JOB42'])).rows[0].id;
    expect(one).not.toBe(two);
    expect((await db.query('SELECT id FROM career.opportunity_identities WHERE opportunity_id = ANY($1::uuid[])', [[one, two]])).rowCount).toBe(0);
    await db.query(insert, [owner, 'portal', 'empresa_a', 'JOB42']);
    await db.query(insert, [owner, 'portal', 'empresa_b', 'JOB42']);
  });
  it('exige ordens positivas e únicas por proprietário', async () => {
    await application(await opportunity(), { cycle_order: 1, cycle_relation: 'after_reset' });
    const opp = await opportunity();
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,cycle_order) VALUES ($1,$2,1)', [owner, opp], '23505');
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,cycle_order) VALUES ($1,$2,0)', [owner, opp], '23514');
  });
  it('mantém identificadores e ordens já atribuídos', async () => {
    const id = await application(await opportunity(), { cycle_order: 1 });
    for (const [column, value] of [['id', randomUUID()], ['display_id', 'N999999'], ['cycle_order', 2]]) {
      await expectSqlState(db, `UPDATE career.applications SET ${column}=$2 WHERE id=$1`, [id, value], '23514');
    }
  });
  it('separa namespaces legados e novos', async () => {
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,legacy_id,display_id) VALUES ($1,$2,$3,$4)', [owner, await opportunity(), 'V12', 'N000012'], '23514');
    await expectSqlState(db, 'INSERT INTO career.applications (owner_id,opportunity_id,display_id) VALUES ($1,$2,$3)', [owner, await opportunity(), 'V12'], '23514');
  });
  it('não permite links sem alvo nem alvos de outro proprietário', async () => {
    await expectSqlState(db, 'INSERT INTO career.links (owner_id,original_url,kind) VALUES ($1,$2,$3)', [owner, 'https://example.invalid/job', 'vaga'], '23514');
    await expectSqlState(db, 'INSERT INTO career.links (owner_id,opportunity_id,original_url,kind) VALUES ($1,$2,$3,$4)', [owner, await opportunity(otherOwner), 'https://example.invalid/job', 'vaga'], '23503');
  });
  it('exige tarefa vinculada e FK composta de evento', async () => {
    await expectSqlState(db, 'INSERT INTO career.tasks (owner_id,title) VALUES ($1,$2)', [owner, 'Revisar'], '23514');
    const foreignApp = await application(await opportunity(otherOwner), { owner_id: otherOwner });
    await expectSqlState(db, 'INSERT INTO career.events (owner_id,application_id,kind,state) VALUES ($1,$2,$3,$4)', [owner, foreignApp, 'nota', 'informado'], '23503');
  });
  it('preserva data opcional desconhecida de uma evidência como null', async () => {
    const evidence = await db.query("INSERT INTO career.evidence (owner_id,kind,original_text) VALUES ($1,'relato_usuario','Registro sintético') RETURNING occurred_date", [owner]);
    expect(evidence.rows[0].occurred_date).toBeNull();
  });
  it('exige metas positivas e preserva contador de ciclo crescente', async () => {
    await expectSqlState(db, 'INSERT INTO career.owner_settings (owner_id,daily_goal) VALUES ($1,0)', [owner], '23514');
    const cycle = (await db.query('INSERT INTO career.cycles (owner_id) VALUES ($1) RETURNING id', [owner])).rows[0].id;
    await expectSqlState(db, 'INSERT INTO career.batches (owner_id,cycle_id,batch_number,target) VALUES ($1,$2,1,0)', [owner, cycle], '23514');
    await db.query('UPDATE career.cycles SET next_order=3 WHERE id=$1', [cycle]);
    await expectSqlState(db, 'UPDATE career.cycles SET next_order=2 WHERE id=$1', [cycle], '23514');
  });
  it('preserva membros fechados e snapshots de revisão', async () => {
    const app = await application(await opportunity());
    const cycle = (await db.query('INSERT INTO career.cycles (owner_id) VALUES ($1) RETURNING id', [owner])).rows[0].id;
    const batch = (await db.query('INSERT INTO career.batches (owner_id,cycle_id,batch_number) VALUES ($1,$2,1) RETURNING id', [owner, cycle])).rows[0].id;
    const member = (await db.query('INSERT INTO career.batch_members (owner_id,batch_id,application_id,captured_order) VALUES ($1,$2,$3,1) RETURNING id', [owner, batch, app])).rows[0].id;
    const review = (await db.query('INSERT INTO career.review_versions (owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids) VALUES ($1,$2,1,$3,$4,$5,$6) RETURNING id', [owner, batch, 'original', { schemaVersion: 1 }, [app], []])).rows[0].id;
    await db.query("UPDATE career.batches SET status='closed' WHERE id=$1", [batch]);
    await expectSqlState(db, 'UPDATE career.batch_members SET eligible=false WHERE id=$1', [member], '23514');
    await expectSqlState(db, 'DELETE FROM career.batch_members WHERE id=$1', [member], '23514');
    await expectSqlState(db, 'UPDATE career.review_versions SET narrative=$2 WHERE id=$1', [review, 'Alteração'], '23514');
    await expectSqlState(db, "UPDATE career.batches SET status='open' WHERE id=$1", [batch], '23514');
  });
  it('deduplica criação entre atores e requer controles persistentes', async () => {
    const clientId = randomUUID();
    const app = await application(await opportunity());
    const insert = 'INSERT INTO career.creation_requests (owner_id,entity_type,client_id,payload_hash,result_application_id) VALUES ($1,$2,$3,$4,$5)';
    await db.query(insert, [owner, 'application', clientId, 'a'.repeat(64), app]);
    await expectSqlState(db, insert, [owner, 'application', clientId, 'a'.repeat(64), app], '23505');
    const expected = ['owner_config','owner_settings','opportunities','applications','links','resume_refs','application_resumes','evidence','events','contacts','tasks','cycles','batches','batch_members','review_versions','import_runs','source_files','import_rows','audit_log','mutation_keys','agent_credentials','creation_requests','opportunity_identities','maintenance_state','restore_runs','restore_row_ledger'];
    const names = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='career'")).rows.map((row) => row.tablename);
    expect(names.sort()).toEqual(expected.sort());
    // Toda FK de entidade privada transporta o proprietário, inclusive relações opcionais.
    const foreignKeys = await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='career'::regnamespace AND contype='f'");
    expect(foreignKeys.rows.length).toBeGreaterThan(20);
    for (const row of foreignKeys.rows) expect(row.definition).toMatch(/FOREIGN KEY \(owner_id,/);
  });
  it('vincula manutenção ao manifesto correto e exige restauração completa', async () => {
    const run = (await db.query('INSERT INTO career.restore_runs (owner_id,destination_owner_id,manifest_hash,format_version,expected_rows) VALUES ($1,$1,$2,1,2) RETURNING id', [owner, 'a'.repeat(64)])).rows[0].id;
    await expectSqlState(db, "INSERT INTO career.maintenance_state (owner_id,state,active_restore_run_id,manifest_hash) VALUES ($1,'restoring',$2,$3)", [owner, run, 'b'.repeat(64)], '23503');
    await expectSqlState(db, "UPDATE career.restore_runs SET state='completed',verified_at=now() WHERE id=$1", [run], '23514');
    await db.query("INSERT INTO career.maintenance_state (owner_id,state,active_restore_run_id,manifest_hash) VALUES ($1,'restoring',$2,$3)", [owner, run, 'a'.repeat(64)]);
    await db.query("UPDATE career.restore_runs SET state='completed',restored_rows=2,verified_at=now() WHERE id=$1", [run]);
  });
  it('rejeita repetição de importação, token em claro e escopo fora da lista', async () => {
    const run = 'INSERT INTO career.import_runs (owner_id,importer_version,source_set_hash) VALUES ($1,$2,$3)';
    await db.query(run, [owner, 'synthetic-v1', 'a'.repeat(64)]);
    await expectSqlState(db, run, [owner, 'synthetic-v1', 'a'.repeat(64)], '23505');
    const credential = 'INSERT INTO career.agent_credentials (owner_id,label,prefix,token_hash,scopes) VALUES ($1,$2,$3,$4,$5)';
    await expectSqlState(db, credential, [owner, 'Teste', 'ct_test', 'texto-em-claro', ['career:read']], '23514');
    await expectSqlState(db, credential, [owner, 'Teste', 'ct_test', 'a'.repeat(64), ['career:admin']], '23514');
  });
});

describe('mutações atômicas usando dois pools com login restrito', () => {
  const runtimeOwner = randomUUID(); const foreignOwner = randomUUID();
  let setup: pg.Client;
  let first: ReturnType<typeof createDatabase>;
  let second: ReturnType<typeof createDatabase>;
  let actor: Awaited<ReturnType<typeof authenticateBearer>>;
  const logs: string[] = [];
  const logger = createSafeLogger((line) => logs.push(line));
  const input = z.strictObject({ id: z.uuid(), expectedVersion: z.number().int().positive(), notes: z.string().max(1000) });
  const response = z.strictObject({ id: z.uuid(), version: z.number().int(), eventId: z.uuid() });
  beforeAll(async () => {
    setup = await connectTestDatabase();
    const password = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: runtimeOwner, apiPassword: password, restorePassword: randomBytes(32).toString('base64url') });
    const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!); url.username = 'career_api'; url.password = password;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', DATABASE_POOL_MAX: '1', OWNER_USER_ID: runtimeOwner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    first = createDatabase({ ...config, database: { ...config.database, application_name: 'task04-first' } });
    second = createDatabase({ ...config, database: { ...config.database, application_name: 'task04-second' } });
    actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: runtimeOwner } }, error: null }) });
  });
  afterAll(async () => {
    await first?.close(); await second?.close();
    if (setup) {
      for (const table of ['mutation_keys', 'events', 'evidence', 'agent_credentials', 'applications', 'opportunity_identities', 'opportunities', 'owner_settings', 'audit_log', 'maintenance_state', 'owner_config']) await setup.query(`DELETE FROM career.${table} WHERE owner_id=ANY($1::uuid[])`, [[runtimeOwner, foreignOwner]]);
      await setup.end();
    }
  });
  async function seed(ownerId = runtimeOwner) {
    const opportunity = randomUUID(); const id = randomUUID();
    await setup.query('INSERT INTO career.opportunities(id,owner_id) VALUES($1,$2)', [opportunity, ownerId]);
    await setup.query('INSERT INTO career.applications(id,owner_id,opportunity_id) VALUES($1,$2,$3)', [id, ownerId, opportunity]);
    return id;
  }
  function synthetic(database = first, afterRecord: () => Promise<void> = async () => undefined) {
    return createMutation(database, { operation: 'synthetic_edit', commandSchema: input, responseSchema: response, logger,
      execute: async (context, command) => {
        await context.lockAggregates([{ table: 'applications', id: command.id }]);
        const changed = await context.updateApplication(command.id, command.expectedVersion, { notes: command.notes });
        const evidenceId = randomUUID(); const eventId = randomUUID();
        await context.transaction.query("INSERT INTO career.evidence(id,owner_id,kind,original_text) VALUES($1,$2,'relato_usuario','Evidência sintética.')", [evidenceId, context.ownerId]);
        await afterRecord();
        await context.transaction.query("INSERT INTO career.events(id,owner_id,application_id,kind,state,evidence_id) VALUES($1,$2,$3,'nota','informado',$4)", [eventId, context.ownerId, command.id, evidenceId]);
        return { status: 200, body: { ...changed, eventId } };
      },
    });
  }
  function barrier() {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    return { started, release, hold: async () => { entered(); await waiting; } };
  }
  async function expectBlockedSecond() {
    await expect.poll(async () => (await setup.query("SELECT wait_event_type FROM pg_stat_activity WHERE application_name='task04-second' AND state='active'")).rows[0]?.wait_event_type).toBe('Lock');
  }
  it('executa uma vez com mesmo ator/chave/corpo simultâneos e repete a resposta original', async () => {
    const id = await seed(); const key = randomUUID(); const gate = barrier();
    const a = synthetic(first, gate.hold)(actor, { idempotencyKey: key, command: { id, expectedVersion: 1, notes: 'Uma alteração.' } });
    await gate.started;
    const b = synthetic(second)(actor, { command: { notes: 'Uma alteração.', expectedVersion: 1, id }, idempotencyKey: key });
    try { await expectBlockedSecond(); } finally { gate.release(); }
    const [one, two] = await Promise.all([a, b]);
    expect(two.body).toEqual(one.body); expect(two.status).toBe(one.status);
    expect(two.requestId).not.toBe(one.requestId);
    expect((await setup.query('SELECT version FROM career.applications WHERE id=$1', [id])).rows[0].version).toBe(2);
    expect((await setup.query('SELECT id FROM career.events WHERE application_id=$1', [id])).rowCount).toBe(1);
    expect((await setup.query('SELECT entity_type FROM career.audit_log WHERE request_id=$1', [one.requestId])).rows.map((row) => row.entity_type).sort()).toEqual(['applications', 'events', 'evidence']);
    expect((await setup.query('SELECT id FROM career.audit_log WHERE request_id=$1', [two.requestId])).rowCount).toBe(0);
    expect(logs.map((line) => JSON.parse(line)).filter((line) => line.requestId === one.requestId)).toEqual([expect.objectContaining({ operation: 'synthetic_edit', status: 200 })]);
  });
  it('recusa reutilização simultânea da chave com corpo diferente', async () => {
    const id = await seed(); const key = randomUUID(); const gate = barrier();
    const a = synthetic(first, gate.hold)(actor, { idempotencyKey: key, command: { id, expectedVersion: 1, notes: 'Primeira.' } });
    await gate.started;
    const b = synthetic(second)(actor, { idempotencyKey: key, command: { id, expectedVersion: 1, notes: 'Outra.' } });
    const rejected = expect(b).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT', requestId: expect.any(String) });
    try { await expectBlockedSecond(); } finally { gate.release(); }
    await a; await rejected;
    expect((await setup.query('SELECT notes,version FROM career.applications WHERE id=$1', [id])).rows[0]).toEqual({ notes: 'Primeira.', version: 2 });
  });
  it('informa conflito recuperável entre edições concorrentes com versão antiga', async () => {
    const id = await seed(); const gate = barrier();
    const a = synthetic(first, gate.hold)(actor, { idempotencyKey: randomUUID(), command: { id, expectedVersion: 1, notes: 'Atual.' } });
    await gate.started;
    const staleKey = randomUUID();
    const b = synthetic(second)(actor, { idempotencyKey: staleKey, command: { id, expectedVersion: 1, notes: 'Antiga.' } });
    const rejected = expect(b).rejects.toMatchObject({ status: 409, code: 'CONFLICT', details: { currentVersion: 2, changedFields: ['notes'] } });
    try { await expectBlockedSecond(); } finally { gate.release(); }
    await a; await rejected;
    expect((await setup.query('SELECT id FROM career.mutation_keys WHERE idempotency_key=$1', [staleKey])).rowCount).toBe(0);
    const recovered = await synthetic(second)(actor, { idempotencyKey: staleKey, command: { id, expectedVersion: 2, notes: 'Reconciliada.' } });
    expect(recovered.body.version).toBe(3);
  });
  it('falha entre registro e evento reverte versão, chave e auditoria; retry pode concluir', async () => {
    const id = await seed(); const key = randomUUID();
    const evidenceBefore = (await setup.query('SELECT count(*)::integer AS n FROM career.evidence WHERE owner_id=$1', [runtimeOwner])).rows[0].n;
    const command = { id, expectedVersion: 1, notes: 'Privado https://private.invalid/' };
    const failure = synthetic(first, async () => { throw new Error('SQL secret token payload'); })(actor, { idempotencyKey: key, command });
    await expect(failure).rejects.toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
    await failure.catch((error: { requestId: string }) => {
      expect(logs.map((line) => JSON.parse(line)).filter((line) => line.requestId === error.requestId)).toEqual([expect.objectContaining({ status: 503, operation: 'synthetic_edit' })]);
    });
    expect((await setup.query('SELECT notes,version FROM career.applications WHERE id=$1', [id])).rows[0]).toEqual({ notes: null, version: 1 });
    expect((await setup.query('SELECT id FROM career.events WHERE application_id=$1', [id])).rowCount).toBe(0);
    expect((await setup.query('SELECT id FROM career.audit_log WHERE entity_id=$1', [id])).rowCount).toBe(0);
    expect((await setup.query('SELECT id FROM career.mutation_keys WHERE idempotency_key=$1', [key])).rowCount).toBe(0);
    expect((await setup.query('SELECT count(*)::integer AS n FROM career.evidence WHERE owner_id=$1', [runtimeOwner])).rows[0].n).toBe(evidenceBefore);
    expect((await synthetic()(actor, { idempotencyKey: key, command })).body.version).toBe(2);
    expect(logs.join('')).not.toMatch(/private.invalid|SQL|secret|payload|Privado/);
  });
  it('não revela versão nem campos de candidatura alheia ou ausente', async () => {
    for (const id of [await seed(foreignOwner), randomUUID()]) {
      const result = synthetic()(actor, { idempotencyKey: randomUUID(), command: { id, expectedVersion: 1, notes: 'Não autorizada.' } });
      await expect(result).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', details: undefined });
    }
  });
  it('rejeita ator forjado e campos de contexto enviados no comando antes de gravar', async () => {
    const id = await seed(); const envelope = { idempotencyKey: randomUUID(), command: { id, expectedVersion: 1, notes: 'Teste' } };
    await expect(synthetic()({ ...actor }, envelope)).rejects.toMatchObject({ status: 401 });
    for (const field of ['ownerId', 'actorId', 'actorKind', 'source', 'requestId']) await expect(synthetic()(actor, { ...envelope, command: { ...envelope.command, [field]: foreignOwner } })).rejects.toMatchObject({ status: 400 });
    expect((await setup.query('SELECT id FROM career.mutation_keys WHERE idempotency_key=$1', [envelope.idempotencyKey])).rowCount).toBe(0);
  });
  it('replay de credencial contém apenas metadados aprovados e nenhum hash', async () => {
    const credential = createMutation(first, { operation: 'synthetic_credential',
      commandSchema: z.strictObject({ id: z.uuid(), tokenHash: z.string().length(64) }),
      responseSchema: z.strictObject({ id: z.uuid(), prefix: z.string(), scopes: z.array(z.string()) }), logger,
      execute: async (context, command) => {
        const row = await context.transaction.query('INSERT INTO career.agent_credentials(id,owner_id,label,prefix,token_hash,scopes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,prefix,scopes', [command.id, context.ownerId, 'Sintética', 'ct_test', command.tokenHash, ['career:read']]);
        return { status: 201, body: row.rows[0] as { id: string; prefix: string; scopes: string[] } };
      },
    });
    const envelope = { idempotencyKey: randomUUID(), command: { id: randomUUID(), tokenHash: 'e'.repeat(64) } };
    const created = await credential(actor, envelope); const replay = await credential(actor, envelope);
    expect(replay.body).toEqual({ id: envelope.command.id, prefix: 'ct_test', scopes: ['career:read'] });
    expect(replay.body).toEqual(created.body);
    const stored = (await setup.query('SELECT safe_response FROM career.mutation_keys WHERE idempotency_key=$1', [envelope.idempotencyKey])).rows;
    expect(JSON.stringify(stored) + JSON.stringify(replay) + logs.join('')).not.toMatch(/tokenHash|token_hash|eeeeeeeeeeeeeeee/);
  });
  it('resposta com campo de credencial não aprovado reverte o negócio e a reserva', async () => {
    const id = await seed(); const key = randomUUID();
    const unsafe = createMutation(first, { operation: 'synthetic_unsafe_reply', commandSchema: input,
      responseSchema: z.strictObject({ id: z.uuid(), version: z.number() }), logger,
      execute: async (context, command) => {
        const changed = await context.updateApplication(command.id, command.expectedVersion, { notes: command.notes });
        return { status: 200, body: { ...changed, token_hash: 'd'.repeat(64) } };
      },
    });
    await expect(unsafe(actor, { idempotencyKey: key, command: { id, expectedVersion: 1, notes: 'Não deve persistir.' } })).rejects.toMatchObject({ status: 503 });
    expect((await setup.query('SELECT version FROM career.applications WHERE id=$1', [id])).rows[0].version).toBe(1);
    expect((await setup.query('SELECT id FROM career.mutation_keys WHERE idempotency_key=$1', [key])).rowCount).toBe(0);
  });
  it('ordena locks de múltiplos agregados e rejeita aquisição incremental invertida', async () => {
    const ids = [await seed(), await seed()].sort();
    const lock = (database: ReturnType<typeof createDatabase>, reversed: boolean) => createMutation(database, {
      operation: 'synthetic_locks', commandSchema: z.strictObject({}), responseSchema: z.strictObject({ ok: z.literal(true) }), logger,
      execute: async (context) => {
        await context.lockAggregates((reversed ? [...ids].reverse() : ids).map((id) => ({ table: 'applications', id })));
        return { status: 200, body: { ok: true as const } };
      },
    });
    const replies = await Promise.all([lock(first, true)(actor, { idempotencyKey: randomUUID(), command: {} }), lock(second, false)(actor, { idempotencyKey: randomUUID(), command: {} })]);
    expect(replies.map((reply) => reply.body)).toEqual([{ ok: true }, { ok: true }]);
    const incremental = createMutation(first, { operation: 'synthetic_inverted_locks', commandSchema: z.strictObject({}), responseSchema: z.strictObject({ ok: z.literal(true) }), logger,
      execute: async (context) => {
        await context.lockAggregates([{ table: 'applications', id: ids[1]! }]);
        await context.lockAggregates([{ table: 'applications', id: ids[0]! }]);
        return { status: 200, body: { ok: true as const } };
      },
    });
    await expect(incremental(actor, { idempotencyKey: randomUUID(), command: {} })).rejects.toMatchObject({ status: 503, code: 'NOT_CONFIGURED' });
  });
});
