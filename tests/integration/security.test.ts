import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { connectTestDatabase, expectSqlState } from '../helpers/database';
import { localDatabaseConfig, runLocalDatabase, validateSecurityCatalog } from '../../scripts/local-db';
import { provisionOwner } from '../../scripts/provision-owner';
import { authenticateBearer } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase, MAINTENANCE_LOCK } from '../../server/database';

let admin: pg.Client;
beforeAll(async () => { admin = await connectTestDatabase(); });
afterAll(async () => { await admin?.end(); });

describe('catálogo de segurança', () => {
  it('aplica o schema antes de validar o catálogo de segurança', async () => {
    await expect(runLocalDatabase('apply', process.env.LOCAL_TEST_DATABASE_URL)).resolves.toBeUndefined();
  });
  it('valida privilégios mínimos de tabelas, colunas, sequências e funções', async () => {
    await expect(validateSecurityCatalog(admin)).resolves.toBeUndefined();
  });
  it.each([
    'GRANT INSERT ON career.audit_log TO career_api',
    'GRANT UPDATE(owner_id) ON career.maintenance_state TO career_restore',
    'GRANT EXECUTE ON FUNCTION career.register_opportunity_identity() TO career_api',
    'GRANT career_schema_owner TO career_api',
    'ALTER ROLE career_api BYPASSRLS',
    'ALTER TABLE career.contacts NO FORCE ROW LEVEL SECURITY',
    'GRANT SELECT ON career.contacts TO career_audit_writer',
    'ALTER TABLE career.contacts DISABLE TRIGGER business_audit',
    'ALTER FUNCTION career.audit_business_change() SET search_path=public',
    'ALTER TABLE career.mutation_keys DISABLE TRIGGER mutation_reply_complete',
    'ALTER TABLE career.batch_members DISABLE TRIGGER batch_members_insert_guard',
  ])('detecta desvio inseguro do catálogo: %s', async (sql) => {
    await admin.query('BEGIN');
    try { await admin.query(sql); await expect(validateSecurityCatalog(admin)).rejects.toThrow('segurança'); }
    finally { await admin.query('ROLLBACK'); }
  });
  it('atribui tabelas a um papel sem login e força RLS em todas', async () => {
    const { rows } = await admin.query(`SELECT c.relname, r.rolname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
      WHERE c.relnamespace='career'::regnamespace AND c.relkind='r'`);
    expect(rows.length).toBe(26);
    for (const row of rows) expect(row).toMatchObject({ rolname: 'career_schema_owner', relrowsecurity: true, relforcerowsecurity: true });
  });
  it('separa quatro papéis sem bypass e sem associação entre papéis', async () => {
    const { rows } = await admin.query(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`, [['career_api', 'career_restore', 'career_schema_owner', 'career_audit_writer']]);
    expect(rows).toHaveLength(4);
    for (const role of rows) expect(role).toMatchObject({ rolcanlogin: ['career_api', 'career_restore'].includes(role.rolname), rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await admin.query(`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=ANY($1)`, [rows.map((r) => r.rolname)])).rows).toHaveLength(0);
  });
  it('nega acesso aos papéis equivalentes da Data API no PostgreSQL independente', async () => {
    await admin.query('BEGIN');
    try {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        const { rows } = await admin.query(`SELECT has_schema_privilege($1,'career','USAGE') AS schema,
          has_table_privilege($1,'career.opportunities','SELECT') AS business,
          has_function_privilege($1,'career.configured_owner()','EXECUTE') AS helper`, [role]);
        expect(rows[0]).toEqual({ schema: false, business: false, helper: false });
      }
      await validateSecurityCatalog(admin);
    } finally { await admin.query('ROLLBACK'); }
  });
});

describe('login real, isolamento e restauração restrita', () => {
  const owner = randomUUID();
  const foreign = randomUUID();
  const ownerOpportunity = randomUUID();
  const foreignOpportunity = randomUUID();
  const apiPassword = randomBytes(32).toString('base64url');
  const restorePassword = randomBytes(32).toString('base64url');
  let api: pg.Client;
  let restore: pg.Client;
  let database: ReturnType<typeof createDatabase>;
  let actor: Awaited<ReturnType<typeof authenticateBearer>>;
  const provisioning = () => provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword, restorePassword });
  beforeAll(async () => {
    await provisioning();
    const connection = localDatabaseConfig(process.env.LOCAL_TEST_DATABASE_URL);
    api = new pg.Client({ ...connection, user: 'career_api', password: apiPassword });
    restore = new pg.Client({ ...connection, user: 'career_restore', password: restorePassword });
    await api.connect();
    await restore.connect();
    const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!);
    url.username = 'career_api'; url.password = apiPassword;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', DATABASE_POOL_MAX: '1', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    database = createDatabase(config);
    actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
    await admin.query('INSERT INTO career.opportunities (id,owner_id,title) VALUES ($1,$2,$3),($4,$5,$6)', [ownerOpportunity, owner, 'Própria', foreignOpportunity, foreign, 'Alheia']);
  });
  beforeEach(async () => { await api.query('BEGIN'); await restore.query('BEGIN'); });
  afterEach(async () => {
    await api?.query('ROLLBACK'); await restore?.query('ROLLBACK');
    if (admin) await admin.query("UPDATE career.maintenance_state SET state='ready',active_restore_run_id=NULL,manifest_hash=NULL WHERE owner_id=$1", [owner]);
  });
  afterAll(async () => {
    await database?.close(); await api?.end(); await restore?.end();
    // Somente UUIDs sintéticos gerados por esta suíte; não limpar tabelas globais.
    for (const table of ['maintenance_state', 'restore_row_ledger', 'restore_runs', 'opportunity_identities', 'opportunities', 'owner_settings', 'audit_log', 'owner_config']) {
      await admin.query(`DELETE FROM career.${table} WHERE owner_id=ANY($1::uuid[])`, [[owner, foreign]]);
    }
  });
  async function context(client = api, ownerId = owner) {
    await client.query(`SELECT set_config('app.owner_id',$1,true),set_config('app.actor_kind','owner',true),
      set_config('app.actor_id',$1,true),set_config('app.source','web',true),set_config('app.request_id',$2,true)`, [ownerId, randomUUID()]);
  }
  async function activateRestore() {
    const id = randomUUID(); const hash = 'a'.repeat(64);
    await admin.query("INSERT INTO career.restore_runs(id,owner_id,destination_owner_id,manifest_hash,format_version,expected_rows,state) VALUES($1,$2,$2,$3,1,99,'restoring')", [id, owner, hash]);
    await admin.query("UPDATE career.maintenance_state SET state='restoring',active_restore_run_id=$1,manifest_hash=$2 WHERE owner_id=$3", [id, hash, owner]);
    await restore.query("SELECT set_config('app.restore_run_id',$1,true)", [id]);
    return id;
  }
  it('conecta como os próprios papéis, sem SET ROLE administrativo', async () => {
    expect((await api.query('SELECT session_user,current_user')).rows[0]).toEqual({ session_user: 'career_api', current_user: 'career_api' });
    expect((await restore.query('SELECT session_user,current_user')).rows[0]).toEqual({ session_user: 'career_restore', current_user: 'career_restore' });
    await expectSqlState(api, 'SET ROLE career_schema_owner', [], '42501');
    await expectSqlState(api, 'SET ROLE career_restore', [], '42501');
    await expectSqlState(api, 'SET ROLE career_audit_writer', [], '42501');
    await expectSqlState(restore, 'SET ROLE career_api', [], '42501');
  });
  it('não vaza linhas sem contexto ou com segundo proprietário', async () => {
    expect((await api.query('SELECT * FROM career.opportunities')).rows).toHaveLength(0);
    await expectSqlState(api, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [owner], '42501');
    await context(api, foreign);
    expect((await api.query('SELECT * FROM career.opportunities')).rows).toHaveLength(0);
    expect((await api.query('SELECT * FROM career.opportunities WHERE id=$1', [foreignOpportunity])).rows).toHaveLength(0);
    expect((await api.query('UPDATE career.opportunities SET title=$1 WHERE id=$2', ['Violação', foreignOpportunity])).rowCount).toBe(0);
    await expectSqlState(api, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [foreign], '42501');
  });
  it('lista, lê por ID, insere e atualiza apenas linhas próprias', async () => {
    await context();
    expect((await api.query('SELECT id FROM career.opportunities')).rows).toEqual([{ id: ownerOpportunity }]);
    expect((await api.query('SELECT id FROM career.opportunities WHERE id=$1', [foreignOpportunity])).rows).toHaveLength(0);
    expect((await api.query('UPDATE career.opportunities SET title=$1 WHERE id=$2 RETURNING title', ['Alterada', ownerOpportunity])).rows[0].title).toBe('Alterada');
    await expectSqlState(api, 'UPDATE career.opportunities SET owner_id=$1 WHERE id=$2', [foreign, ownerOpportunity], '42501');
    const opportunity = (await api.query('INSERT INTO career.opportunities(owner_id,platform,tenant,job_code) VALUES($1,$2,$3,$4) RETURNING id', [owner, 'Portal', 'Tenant', '123'])).rows[0].id;
    const application = (await api.query('INSERT INTO career.applications(owner_id,opportunity_id) VALUES($1,$2) RETURNING display_id', [owner, opportunity])).rows[0];
    expect(application.display_id).toMatch(/^N[0-9]{6,}$/);
    await expectSqlState(api, 'INSERT INTO career.applications(owner_id,opportunity_id) VALUES($1,$2)', [owner, foreignOpportunity], '23503');
    await expectSqlState(api, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [foreign], '42501');
  });
  it('nega controle, histórico forjado, alteração de versões e manipulação de triggers', async () => {
    await context();
    for (const sql of [
      'UPDATE career.owner_config SET owner_id=gen_random_uuid()',
      "UPDATE career.maintenance_state SET state='ready'",
      'DELETE FROM career.owner_config', 'INSERT INTO career.owner_config(owner_id) VALUES(gen_random_uuid())',
      'SELECT * FROM career.restore_runs', 'INSERT INTO career.audit_log DEFAULT VALUES',
      'UPDATE career.audit_log SET source=\'forged\'', 'DELETE FROM career.audit_log',
      'UPDATE career.review_versions SET narrative=\'changed\'', 'DELETE FROM career.review_versions',
      'ALTER TABLE career.opportunities DISABLE TRIGGER ALL', 'TRUNCATE career.opportunities',
      'CREATE TABLE career.forged(id integer)', 'SELECT career.register_opportunity_identity()',
    ]) await expectSqlState(api, sql, [], '42501');
  });
  it('insere revisão própria e mantém sua versão imutável', async () => {
    await context();
    const cycle = (await api.query('INSERT INTO career.cycles(owner_id) VALUES($1) RETURNING id', [owner])).rows[0].id;
    const batch = (await api.query('INSERT INTO career.batches(owner_id,cycle_id,batch_number) VALUES($1,$2,1) RETURNING id', [owner, cycle])).rows[0].id;
    const review = await api.query("INSERT INTO career.review_versions(owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids) VALUES($1,$2,1,'original','{}','{}','{}') RETURNING id", [owner, batch]);
    expect(review.rows).toHaveLength(1);
    await expectSqlState(api, 'UPDATE career.review_versions SET narrative=$1 WHERE id=$2', ['alterada', review.rows[0].id], '42501');
  });
  it('remove contexto no commit e no rollback na mesma conexão', async () => {
    for (const finish of ['COMMIT', 'ROLLBACK']) {
      await context();
      expect((await api.query('SELECT id FROM career.opportunities')).rows).toHaveLength(1);
      await api.query(finish); await api.query('BEGIN');
      expect((await api.query('SELECT id FROM career.opportunities')).rows).toHaveLength(0);
      expect((await api.query("SELECT nullif(current_setting('app.owner_id',true),'') AS owner")).rows[0].owner).toBeNull();
    }
  });
  it('restauração vê proprietários alheios e não insere sem execução persistida ativa', async () => {
    expect((await restore.query('SELECT id FROM career.opportunities ORDER BY id')).rows).toHaveLength(2);
    await restore.query("SELECT set_config('app.restore_run_id',$1,true),set_config('app.restore','true',true)", [randomUUID()]);
    await expectSqlState(restore, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [owner], '42501');
    await expectSqlState(restore, 'UPDATE career.opportunities SET title=$1', ['forged'], '42501');
    await expectSqlState(restore, 'DELETE FROM career.opportunities', [], '42501');
    await expectSqlState(restore, 'INSERT INTO career.agent_credentials DEFAULT VALUES', [], '42501');
    await expectSqlState(restore, 'SELECT token_hash FROM career.agent_credentials', [], '42501');
    await restore.query('SELECT id,owner_id,expires_at,revoked_at FROM career.agent_credentials');
  });
  it('restore insere histórico apenas no destino/run/manifesto ativo; runtime fica fechado', async () => {
    const run = await activateRestore();
    await context();
    expect((await api.query('SELECT * FROM career.opportunities')).rows).toHaveLength(0);
    await expectSqlState(api, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [owner], '42501');
    await expectSqlState(restore, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [foreign], '42501');
    const result = await restore.query('INSERT INTO career.opportunities(owner_id,platform,tenant,job_code,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id,created_at', [owner, 'Portal', 'Restore', '999', '2020-01-01T00:00:00Z']);
    expect(result.rows[0].created_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    await restore.query("INSERT INTO career.audit_log(owner_id,actor_kind,actor_id,source,entity_type,entity_id,operation,diff,request_id) VALUES($1::uuid,'owner',$1::text,'historical','opportunities',$2,'insert','{}',$3)", [owner, result.rows[0].id, randomUUID()]);
    await restore.query('INSERT INTO career.restore_row_ledger(owner_id,restore_run_id,table_name,row_id,row_hash) VALUES($1,$2,$3,$4,$5)', [owner, run, 'opportunities', result.rows[0].id, 'b'.repeat(64)]);
    await restore.query("SELECT set_config('app.restore_run_id',$1,true)", [randomUUID()]);
    await expectSqlState(restore, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [owner], '42501');
    await restore.query("SELECT set_config('app.restore_run_id',$1,true)", [run]);
    await admin.query("UPDATE career.restore_runs SET state='verifying' WHERE id=$1", [run]);
    await expectSqlState(restore, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [owner], '42501');
  });
  it('provisionamento preserva o dono e rejeita conflito atomicamente', async () => {
    await provisioning();
    await expect(provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: foreign, apiPassword, restorePassword })).rejects.toThrow('proprietário');
    expect((await admin.query('SELECT owner_id FROM career.owner_config')).rows).toEqual([{ owner_id: owner }]);
    expect((await admin.query('SELECT count(*)::integer AS n FROM career.owner_settings WHERE owner_id=$1', [owner])).rows[0].n).toBe(1);
  });
  it('transações da aplicação exigem autenticação e não vazam contexto no pool', async () => {
    await expect(database.transaction({ ...actor }, async () => undefined)).rejects.toMatchObject({ status: 401 });
    await expect(database.transaction(actor, async () => undefined, { requestId: randomUUID() })).rejects.toMatchObject({ status: 503, code: 'NOT_CONFIGURED' });
    await database.assertReady();
    const first = await database.transaction(actor, async (tx) => (await tx.query("SELECT pg_backend_pid() AS pid,current_setting('app.actor_kind') AS actor,current_setting('app.source') AS source,current_setting('app.request_id') AS request")).rows[0]);
    expect(first).toMatchObject({ actor: 'owner', source: 'web' });
    expect(first?.request).toMatch(/^[0-9a-f-]{36}$/);
    await expect(database.transaction(actor, async (tx) => { await tx.query('INSERT INTO career.opportunities(owner_id) VALUES($1)', [owner]); throw new Error('rollback synthetic'); })).rejects.toThrow('rollback synthetic');
    const next = await database.transaction(actor, async (tx) => {
      expect((await tx.query('SELECT id FROM career.opportunities')).rows).toHaveLength(1);
      return (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0];
    });
    expect(next?.pid).toBe(first?.pid);
  });
  it('gate retorna 503 antes do callback durante manutenção ou sem configuração', async () => {
    const callback = vi.fn();
    await activateRestore();
    await expect(database.transaction(actor, callback)).rejects.toMatchObject({ status: 503, code: 'MAINTENANCE' });
    expect(callback).not.toHaveBeenCalled();
    await expect(database.assertReady()).rejects.toMatchObject({ status: 503 });
    await admin.query('DELETE FROM career.owner_config WHERE owner_id=$1', [owner]);
    try {
      await context();
      expect((await api.query('SELECT id FROM career.opportunities')).rows).toHaveLength(0);
      await expectSqlState(api, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [owner], '42501');
      await expect(database.transaction(actor, callback)).rejects.toMatchObject({ status: 503, code: 'NOT_CONFIGURED' });
    }
    finally { await admin.query('INSERT INTO career.owner_config(owner_id) VALUES($1)', [owner]); }
    await admin.query('DELETE FROM career.maintenance_state WHERE owner_id=$1', [owner]);
    try {
      expect((await api.query('SELECT id FROM career.opportunities')).rows).toHaveLength(0);
      await expectSqlState(api, 'INSERT INTO career.opportunities(owner_id) VALUES($1)', [owner], '42501');
      await expect(database.transaction(actor, callback)).rejects.toMatchObject({ status: 503, code: 'NOT_CONFIGURED' });
    }
    finally { await admin.query('INSERT INTO career.maintenance_state(owner_id) VALUES($1)', [owner]); }
  });
  it('lock compartilhado impede transição exclusiva enquanto a transação está ativa', async () => {
    await database.transaction(actor, async () => {
      await admin.query('BEGIN');
      try {
        const { rows } = await admin.query('SELECT pg_try_advisory_xact_lock($1,$2) AS acquired', [...MAINTENANCE_LOCK]);
        expect(rows[0].acquired).toBe(false);
      } finally { await admin.query('ROLLBACK'); }
    });
    await admin.query('BEGIN');
    try { expect((await admin.query('SELECT pg_try_advisory_xact_lock($1,$2) AS acquired', [...MAINTENANCE_LOCK])).rows[0].acquired).toBe(true); }
    finally { await admin.query('ROLLBACK'); }
  });
});
