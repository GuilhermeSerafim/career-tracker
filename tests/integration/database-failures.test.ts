import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { authenticateBearer } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase, MAINTENANCE_LOCK } from '../../server/database';
import { provisionOwner } from '../../scripts/provision-owner';
import { connectTestDatabase } from '../helpers/database';

const owner = randomUUID();
const apiPassword = randomBytes(32).toString('base64url');
let admin: pg.Client;
let config: ReturnType<typeof readServerConfig>;
let actor: Awaited<ReturnType<typeof authenticateBearer>>;
let runtimeEnv: NodeJS.ProcessEnv;
beforeAll(async () => {
  admin = await connectTestDatabase();
  await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword, restorePassword: randomBytes(32).toString('base64url') });
  const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!);
  url.username = 'career_api'; url.password = apiPassword;
  runtimeEnv = { NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', DATABASE_POOL_MAX: '1', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
  config = readServerConfig(runtimeEnv);
  actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
});
afterAll(async () => {
  if (admin) {
    await admin.query('ROLLBACK');
    for (const table of ['contacts', 'maintenance_state', 'owner_settings', 'audit_log', 'owner_config']) await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await admin.end();
  }
});

it('sobrevive ao timeout de cliente retirado do pool e bloqueia o callback após falha', async () => {
  const script = fileURLToPath(new URL('../helpers/database-client-failure.ts', import.meta.url));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ...runtimeEnv },
    });
    let stdout = ''; let stderr = '';
    const deadline = setTimeout(() => { child.kill(); reject(new Error('O processo isolado não encerrou.')); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (code) => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
  });
  expect(result).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(result.stdout)).toEqual({ status: 503, rejectedBeforeResume: true, lateQueryBlocked: true, connectionReplaced: true, rolledBack: true, listenerWarnings: 0 });
});

it.each([
  ['statement_timeout', 'assertReady'], ['statement_timeout', 'transaction'],
  ['lock_timeout', 'assertReady'], ['lock_timeout', 'transaction'],
] as const)('converte %s no gate %s para 503 e mantém recuperação do pool', async (setting, method) => {
  const database = createDatabase({ ...config, database: { ...config.database, [setting]: 100 } });
  const callback = vi.fn();
  try {
    const before = await database.transaction(actor, async (tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    await admin.query('BEGIN');
    await admin.query('SELECT pg_advisory_xact_lock($1,$2)', [...MAINTENANCE_LOCK]);
    const operation = method === 'assertReady' ? database.assertReady() : database.transaction(actor, callback);
    await expect(operation).rejects.toMatchObject({ name: 'SafeError', status: 503, code: 'DATABASE_UNAVAILABLE' });
    expect(callback).not.toHaveBeenCalled();
    await admin.query('ROLLBACK');
    const after = await database.transaction(actor, async (tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    expect(after).toBe(before);
  } finally { await admin.query('ROLLBACK'); await database.close(); }
});

it('converte timeout de consulta em erro seguro sem mascarar erros de domínio', async () => {
  const database = createDatabase({ ...config, database: { ...config.database, statement_timeout: 100 } });
  try {
    await expect(database.transaction(actor, (tx) => tx.query('SELECT pg_sleep(0.5)'))).rejects.toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
    const id = randomUUID();
    await expect(database.transaction(actor, async (tx) => {
      await tx.query('INSERT INTO career.contacts(id,owner_id) VALUES($1,$2)', [id, owner]);
      await tx.query('INSERT INTO career.contacts(id,owner_id) VALUES($1,$2)', [id, owner]);
    })).rejects.toMatchObject({ code: '23505' });
    const domain = new Error('Falha sintética de domínio.');
    await expect(database.transaction(actor, async () => { throw domain; })).rejects.toBe(domain);
    await database.assertReady();
  } finally { await database.close(); }
});
