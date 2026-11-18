import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateBearer } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase } from '../../server/database';
import { provisionOwner } from '../../scripts/provision-owner';
import { localDatabaseConfig } from '../../scripts/local-db';
import { connectTestDatabase, expectSqlState } from '../helpers/database';

const owner = randomUUID();
const password = randomBytes(32).toString('base64url');
let admin: pg.Client;
let api: pg.Client;
let database: ReturnType<typeof createDatabase>;
let actor: Awaited<ReturnType<typeof authenticateBearer>>;
beforeAll(async () => {
  admin = await connectTestDatabase();
  await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword: password, restorePassword: randomBytes(32).toString('base64url') });
  api = new pg.Client({ ...localDatabaseConfig(process.env.LOCAL_TEST_DATABASE_URL), user: 'career_api', password });
  await api.connect();
  const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!);
  url.username = 'career_api'; url.password = password;
  const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
  database = createDatabase(config);
  actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
});
afterAll(async () => {
  await database?.close(); await api?.end();
  if (admin) {
    for (const table of ['mutation_keys', 'agent_credentials', 'contacts', 'owner_settings', 'audit_log', 'maintenance_state', 'owner_config']) await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await admin.end();
  }
});

describe('auditoria pelo login real de execução', () => {
  it('audita bootstrap autorizado com contexto explícito', async () => {
    const rows = (await admin.query("SELECT actor_kind,actor_id,source,entity_type,operation FROM career.audit_log WHERE owner_id=$1 AND entity_type='owner_settings'", [owner])).rows;
    expect(rows).toEqual([{ actor_kind: 'owner', actor_id: owner, source: 'provisioning', entity_type: 'owner_settings', operation: 'insert' }]);
  });
  it('deriva OLD/NEW e inclui apenas campos alterados no diff', async () => {
    const id = randomUUID();
    const request = await database.transaction(actor, async (tx) => {
      await tx.query('INSERT INTO career.contacts(id,owner_id,name) VALUES($1,$2,$3)', [id, owner, 'Antes']);
      await tx.query('UPDATE career.contacts SET name=$2,version=version+1 WHERE id=$1', [id, 'Depois']);
      expect((await tx.query("SELECT current_setting('app.request_id') AS id")).rows[0]?.id).toBe(tx.requestId);
      return tx.requestId;
    });
    const rows = (await admin.query('SELECT * FROM career.audit_log WHERE entity_id=$1 ORDER BY operation', [id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ operation: 'insert', before_data: null, after_data: { name: 'Antes' }, actor_kind: 'owner', actor_id: owner, source: 'web', request_id: request });
    expect(rows[1]).toMatchObject({ operation: 'update', before_data: { name: 'Antes', version: 1 }, after_data: { name: 'Depois', version: 2 }, request_id: request,
      diff: { name: { before: 'Antes', after: 'Depois' }, version: { before: 1, after: 2 } } });
    expect(Object.keys(rows[1].diff).sort()).toEqual(['name', 'version']);
  });
  it('remove hashes antes de gerar snapshots e diff de credenciais', async () => {
    const id = randomUUID();
    await database.transaction(actor, async (tx) => {
      await tx.query('INSERT INTO career.agent_credentials(id,owner_id,label,prefix,token_hash,scopes) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, 'Teste', 'ct_test', 'a'.repeat(64), ['career:read']]);
      await tx.query('UPDATE career.agent_credentials SET token_hash=$2,revoked_at=now(),version=version+1 WHERE id=$1', [id, 'b'.repeat(64)]);
    });
    const rows = (await admin.query('SELECT before_data,after_data,diff FROM career.audit_log WHERE entity_id=$1', [id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.after_data.revoked_at !== null)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/token_hash|aaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbb/);
    for (const row of rows) expect(Object.keys(row.after_data).sort()).toEqual(['created_at', 'expires_at', 'id', 'label', 'owner_id', 'prefix', 'revoked_at', 'scopes', 'updated_at', 'version']);
  });
  it('reverte o registro e sua auditoria quando o callback falha', async () => {
    const id = randomUUID();
    await expect(database.transaction(actor, async (tx) => {
      await tx.query('INSERT INTO career.contacts(id,owner_id) VALUES($1,$2)', [id, owner]);
      const audit = await tx.query('SELECT id FROM career.audit_log WHERE entity_id=$1', [id]);
      expect(audit.rowCount).toBe(1);
      throw new Error('Falha sintética.');
    })).rejects.toThrow('Falha sintética.');
    expect((await admin.query('SELECT id FROM career.contacts WHERE id=$1', [id])).rowCount).toBe(0);
    expect((await admin.query('SELECT id FROM career.audit_log WHERE entity_id=$1', [id])).rowCount).toBe(0);
  });
  it('não permite que flags de restore suprimam auditoria runtime', async () => {
    const id = randomUUID();
    await database.transaction(actor, async (tx) => {
      await tx.query("SELECT set_config('app.restore','true',true),set_config('app.restore_run_id',$1,true),set_config('app.audit_admin','career_api',true)", [randomUUID()]);
      await tx.query('INSERT INTO career.contacts(id,owner_id) VALUES($1,$2)', [id, owner]);
    });
    expect((await admin.query('SELECT id FROM career.audit_log WHERE entity_id=$1', [id])).rowCount).toBe(1);
  });
  it('nega execução direta, auditoria forjada e manipulação de triggers', async () => {
    await api.query('BEGIN');
    try {
      for (const sql of ['SELECT career.audit_business_change()', 'INSERT INTO career.audit_log DEFAULT VALUES', 'UPDATE career.audit_log SET source=\'fake\'', 'DELETE FROM career.audit_log', 'ALTER TABLE career.contacts DISABLE TRIGGER ALL', 'ALTER TABLE career.mutation_keys DISABLE TRIGGER ALL', 'SET ROLE career_audit_writer']) await expectSqlState(api, sql, [], '42501');
    } finally { await api.query('ROLLBACK'); }
  });
  it('rejeita COMMIT de reserva incompleta, inclusive suas alterações de negócio', async () => {
    const key = randomUUID(); const id = randomUUID();
    const operation = database.transaction(actor, async (tx) => {
      await tx.query('INSERT INTO career.contacts(id,owner_id) VALUES($1,$2)', [id, owner]);
      await tx.query("INSERT INTO career.mutation_keys(owner_id,actor_kind,actor_id,operation,idempotency_key,request_hash,http_status,safe_response) VALUES($1,'owner',$2,'synthetic',$3,$4,102,'{}')", [owner, owner, key, 'a'.repeat(64)]);
    });
    await expect(operation).rejects.toMatchObject({ code: '23514' });
    expect((await admin.query('SELECT id FROM career.contacts WHERE id=$1', [id])).rowCount).toBe(0);
    expect((await admin.query('SELECT id FROM career.audit_log WHERE entity_id=$1', [id])).rowCount).toBe(0);
    expect((await admin.query('SELECT id FROM career.mutation_keys WHERE idempotency_key=$1', [key])).rowCount).toBe(0);
  });
  it('mantém namespaces de atores distintos e resposta concluída imutável', async () => {
    const key = randomUUID();
    // Apenas fixture de persistência: não representa autenticação de agente.
    await database.transaction(actor, async (tx) => {
      for (const kind of ['owner', 'agent']) await tx.query("INSERT INTO career.mutation_keys(owner_id,actor_kind,actor_id,operation,idempotency_key,request_hash,http_status,safe_response) VALUES($1,$2,$3,'synthetic',$4,$5,200,'{}')", [owner, kind, owner, key, 'c'.repeat(64)]);
    });
    expect((await admin.query('SELECT actor_kind FROM career.mutation_keys WHERE idempotency_key=$1 ORDER BY actor_kind', [key])).rows).toEqual([{ actor_kind: 'agent' }, { actor_kind: 'owner' }]);
    await expect(database.transaction(actor, (tx) => tx.query('UPDATE career.mutation_keys SET safe_response=$2 WHERE idempotency_key=$1', [key, { forged: true }]))).rejects.toMatchObject({ code: '23514' });
    expect((await admin.query("SELECT id FROM career.audit_log WHERE owner_id=$1 AND entity_type='mutation_keys'", [owner])).rowCount).toBe(0);
  });
  it('nega DML runtime com contexto de auditoria incompleto', async () => {
    await api.query('BEGIN');
    try {
      await api.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
      await expectSqlState(api, 'INSERT INTO career.contacts(owner_id) VALUES($1)', [owner], '42501');
    } finally { await api.query('ROLLBACK'); }
  });
});
