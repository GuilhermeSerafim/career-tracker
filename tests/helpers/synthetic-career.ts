import { randomBytes, randomUUID } from 'node:crypto';
import { connectTestDatabase } from './database';
import { startApi } from './api';
import { provisionOwner } from '../../scripts/provision-owner';
import { validateSecurityCatalog } from '../../scripts/local-db';
import { createDatabase } from '../../server/database';
import { readServerConfig } from '../../server/config';
import { authenticateAgent, authenticateBearer } from '../../server/auth';
import { SafeError } from '../../server/errors';

/** Exclusive synthetic source DB lease required. Never uses a restore destination. */
export async function syntheticCareerApi() {
  const url = new URL(process.env.LOCAL_TEST_DATABASE_URL ?? 'invalid:');
  if (url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/career_tracker_test') throw new Error('Synthetic source database configuration required.');
  const admin = await connectTestDatabase();
  const owner = randomUUID();
  const tables = (await admin.query<{ name: string }>("SELECT relname AS name FROM pg_class WHERE relnamespace='career'::regnamespace AND relkind='r' ORDER BY relname")).rows.map((row) => row.name);
  const checkEmpty = async () => {
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table) || (await admin.query(`SELECT 1 FROM career.${table} LIMIT 1`)).rowCount) throw new Error('Synthetic database contains retained state; stopped.');
    }
  };
  const checkSessions = async () => {
    const sessions = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'");
    if (sessions.rowCount) throw new Error('Synthetic database has another operational session; stopped.');
  };
  let database: ReturnType<typeof createDatabase> | undefined;
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  let provisioned = false;
  const close = async () => {
    try {
      await api?.close(); await database?.close();
      if (provisioned) {
        await admin.query('BEGIN');
        try {
          await admin.query("SET LOCAL session_replication_role='replica'");
          for (const table of tables) await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
          await admin.query('COMMIT');
        } catch (error) { await admin.query('ROLLBACK'); throw error; }
      }
      await checkEmpty(); await validateSecurityCatalog(admin); await checkSessions();
    } finally { await admin.end(); }
  };
  try {
    await checkSessions(); await checkEmpty(); await validateSecurityCatalog(admin);
    const password = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword: password, restorePassword: randomBytes(32).toString('base64url') });
    provisioned = true;
    url.username = 'career_api'; url.password = password;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', DATABASE_POOL_MAX: '1', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic' });
    database = createDatabase(config);
    let unavailable = false;
    api = await startApi({ database, logger: () => undefined, authenticate: (header) => {
      if (unavailable) return Promise.reject(new SafeError('AUTH_UNAVAILABLE'));
      if (header?.startsWith('Bearer ct_agent_')) return authenticateAgent(header, config, database!);
      return authenticateBearer(header, config, { getUser: async (token) => ({ data: { user: { id: token.startsWith('other.') ? randomUUID() : owner } }, error: null }) });
    } });
    const headers = { authorization: 'Bearer synthetic.payload.signature' };
    const request = api.request;
    const gateRun = randomUUID();
    const gateHash = '0'.repeat(64);
    return { owner, request, headers,
      post: (body: unknown) => request('/api/v1/commands', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) }),
      unavailable: (value: boolean) => { unavailable = value; },
      maintenance: async (value: boolean) => {
        // Zero-row source-only metadata fixture, never a restore operation/destination.
        if (value) {
          await admin.query("INSERT INTO career.restore_runs(id,owner_id,destination_owner_id,manifest_hash,format_version,expected_rows) VALUES($1,$2,$2,$3,1,0)", [gateRun, owner, gateHash]);
          await admin.query("UPDATE career.maintenance_state SET state='restoring',active_restore_run_id=$2,manifest_hash=$3 WHERE owner_id=$1", [owner, gateRun, gateHash]);
        } else {
          await admin.query("UPDATE career.maintenance_state SET state='ready',active_restore_run_id=NULL,manifest_hash=NULL WHERE owner_id=$1", [owner]);
          await admin.query('DELETE FROM career.restore_runs WHERE owner_id=$1 AND id=$2', [owner, gateRun]);
        }
      },
      auditCount: async () => Number((await admin.query('SELECT count(*) AS n FROM career.audit_log WHERE owner_id=$1', [owner])).rows[0].n),
      auditActors: async () => (await admin.query('SELECT DISTINCT actor_kind,actor_id FROM career.audit_log WHERE owner_id=$1 ORDER BY actor_kind,actor_id', [owner])).rows,
      foreignContact: async () => { const id = randomUUID(); await admin.query('INSERT INTO career.contacts(id,owner_id,name) VALUES($1,$2,$3)', [id, randomUUID(), 'Foreign synthetic contact']); return id; },
      removeForeignContact: async (id: string) => { await admin.query('DELETE FROM career.contacts WHERE id=$1 AND owner_id<>$2', [id, owner]); },
      close,
    };
  } catch (error) { await close(); throw error; }
}
