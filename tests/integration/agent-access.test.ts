import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { startApi } from '../helpers/api';
import { connectTestDatabase } from '../helpers/database';
import { validateSecurityCatalog } from '../../scripts/local-db';
import { provisionOwner } from '../../scripts/provision-owner';
import { readServerConfig } from '../../server/config';
import { authenticateAgent, authenticateBearer, type AuthenticatedActor } from '../../server/auth';
import { createDatabase } from '../../server/database';
import { unknownDate } from '../fixtures/career';
import { spawn } from 'node:child_process';

const owner = randomUUID(); const human = 'Bearer synthetic.owner.session';
let admin: pg.Client; let database: ReturnType<typeof createDatabase>; let api: Awaited<ReturnType<typeof startApi>>;
let authenticate: (header: string | undefined) => Promise<AuthenticatedActor>;
const logs: unknown[] = [];
const get = (path: string, authorization = human) => api.request('/api/v1/' + path, { headers: { authorization } });
const post = (command: unknown, authorization = human, key = randomUUID()) => api.request('/api/v1/commands', { method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(command) });
async function issue(scopes = ['career:read', 'career:write', 'career:reviews', 'career:export']) {
  const id = randomUUID(); const bytes = randomBytes(32); const token = `Bearer ct_agent_${id}.${bytes.toString('base64url')}`;
  const hash = createHash('sha256').update(bytes).digest('hex'); bytes.fill(0);
  const command = { operation: 'create_agent_credential', clientId: id, label: 'Sintético', prefix: id.slice(0, 8), tokenHash: hash, scopes, expiresAt: null };
  const key = randomUUID(); const result = await post(command, human, key);
  expect(result.status).toBe(201);
  return { id, token, hash, command, result, key };
}
beforeAll(async () => {
  const endpoint = new URL(process.env.LOCAL_TEST_DATABASE_URL ?? 'invalid:');
  if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== '55432' || endpoint.pathname !== '/career_tracker_test') throw new Error('Exclusive synthetic source required.');
  admin = await connectTestDatabase();
  const tables = (await admin.query("SELECT relname FROM pg_class WHERE relnamespace='career'::regnamespace AND relkind='r'")).rows;
  for (const { relname } of tables) if (!/^[a-z_]+$/.test(relname) || (await admin.query(`SELECT 1 FROM career.${relname} LIMIT 1`)).rowCount) throw new Error('Fixture requires empty synthetic source.');
  if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rowCount) throw new Error('Exclusive fixture lease required.');
  await validateSecurityCatalog(admin);
  const password = randomBytes(32).toString('base64url');
  await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword: password, restorePassword: randomBytes(32).toString('base64url') });
  const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!); url.username = 'career_api'; url.password = password;
  const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic' });
  database = createDatabase(config);
  authenticate = header => header?.startsWith('Bearer ct_agent_') ? authenticateAgent(header, config, database) : authenticateBearer(header, config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
  api = await startApi({ database, authenticate, logger: entry => logs.push(entry) });
});
afterAll(async () => {
  await api?.close(); await database?.close();
  if (admin) {
    await admin.query('BEGIN'); await admin.query("SET LOCAL session_replication_role='replica'");
    for (const table of ['mutation_keys','creation_requests','review_versions','batch_members','batches','import_rows','source_files','import_runs','cycles','application_resumes','links','events','tasks','contacts','evidence','resume_refs','applications','opportunity_identities','opportunities','agent_credentials','owner_settings','audit_log','maintenance_state','restore_runs','owner_config']) await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await admin.query('COMMIT'); await validateSecurityCatalog(admin); await admin.end();
  }
});
it('creates once across retry keys and exposes only safe metadata/replay/audit/export/logs', async () => {
  const credential = await issue();
  expect((await post(credential.command, human, credential.key)).json).toEqual(credential.result.json);
  const replay = await post(credential.command);
  expect(replay.status).toBe(201); expect(replay.json.credential.id).toBe(credential.id);
  expect((await admin.query('SELECT count(*)::int AS n FROM career.agent_credentials WHERE owner_id=$1 AND id=$2', [owner, credential.id])).rows[0].n).toBe(1);
  expect((await post({ ...credential.command, label: 'Outra intenção' })).status).toBe(409);
  const listing = await get('agent-credentials?limit=1'); expect(listing.status).toBe(200); expect(listing.json.items).toHaveLength(1);
  const second = await issue(['career:read']);
  const firstPage = await get('agent-credentials?limit=1'); expect(typeof firstPage.json.nextCursor).toBe('string');
  const nextPage = await get('agent-credentials?limit=1&cursor=' + encodeURIComponent(firstPage.json.nextCursor));
  expect(nextPage.json.items[0].id).toBe(second.id);
  expect((await get('agent-credentials?limit=101')).status).toBe(400);
  expect((await get('agent-credentials?ownerId=' + owner)).status).toBe(400);
  const audit = await admin.query('SELECT before_data,after_data,diff FROM career.audit_log WHERE owner_id=$1', [owner]);
  const exported = await get('exports?format=json', credential.token); expect(exported.status).toBe(200);
  const safe = JSON.stringify([replay.json, listing.json, audit.rows, exported.json, logs]);
  expect(safe.includes(credential.hash)).toBe(false); expect(safe.includes(credential.token.slice(7))).toBe(false);
  expect(safe.includes('token_hash')).toBe(false);
});
it('rejects invalid, nonexistent, expired, revoked and changed-scope credentials with correct boundaries', async () => {
  const credential = await issue(['career:read']);
  expect((await get('contacts', credential.token)).status).toBe(200);
  expect((await get('settings', credential.token)).status).toBe(200);
  expect((await get('contacts?ownerId=' + randomUUID(), credential.token)).status).toBe(400);
  expect((await get('agent-credentials', credential.token)).status).toBe(403);
  expect((await get('exports?format=json', credential.token)).status).toBe(403);
  expect((await get('reviews/' + randomUUID() + '?format=markdown', credential.token)).status).toBe(403);
  expect((await get('reviews/' + randomUUID(), credential.token)).status).toBe(404);
  expect((await get('contacts', `Bearer ct_agent_${randomUUID()}.${randomBytes(32).toString('base64url')}`)).status).toBe(401);
  const wrongToken = credential.token.slice(0, -43) + (credential.token.at(-43) === 'A' ? 'B' : 'A') + credential.token.slice(-42);
  expect((await get('contacts', wrongToken)).status).toBe(401);
  const actor = await authenticate(credential.token);
  await expect(database.transaction({ ...actor }, async () => null, undefined, 'career:read')).rejects.toMatchObject({ status: 401 });
  await expect(database.transaction({ ...actor, ownerId: randomUUID() }, async () => null, undefined, 'career:read')).rejects.toMatchObject({ status: 401 });
  await admin.query("UPDATE career.agent_credentials SET scopes=ARRAY['career:write'] WHERE owner_id=$1 AND id=$2", [owner, credential.id]);
  await expect(database.transaction(actor, async () => null, undefined, 'career:read')).rejects.toMatchObject({ status: 403 });
  await admin.query("UPDATE career.agent_credentials SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE owner_id=$1 AND id=$2", [owner, credential.id]);
  expect((await get('contacts', credential.token)).status).toBe(401);
  const live = await issue(); const stale = await authenticate(live.token);
  expect((await post({ operation: 'revoke_agent_credential', credential: { id: live.id, expectedVersion: 1 } })).status).toBe(200);
  expect((await get('contacts', live.token)).status).toBe(401);
  await expect(database.transaction(stale, async () => null, undefined, 'career:read')).rejects.toMatchObject({ status: 401 });
});
it('denies administration/import even with every scope and maintains 503 gate behavior', async () => {
  const c = await issue();
  const settings = (await get('settings')).json;
  expect((await post({ operation: 'update_settings', settings: { id: settings.id, expectedVersion: settings.version }, dailyGoal: 7, timezone: 'America/Sao_Paulo' }, c.token)).status).toBe(403);
  for (const command of [c.command, { operation: 'revoke_agent_credential', credential: { id: c.id, expectedVersion: 1 } }, { operation: 'start_cycle', clientId: randomUUID(), resetDate: { precision: 'unknown', value: null }, resetMarker: null }]) expect((await post(command, c.token)).status).toBe(403);
  for (const path of ['imports/preview','imports/apply','restores/preview']) expect((await api.request('/api/v1/' + path, { method: 'POST', headers: { authorization: c.token, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  const run = randomUUID(); const digest = '0'.repeat(64);
  await admin.query("INSERT INTO career.restore_runs(id,owner_id,destination_owner_id,manifest_hash,format_version,expected_rows) VALUES($1,$2,$2,$3,1,0)", [run, owner, digest]);
  await admin.query("UPDATE career.maintenance_state SET state='restoring',active_restore_run_id=$2,manifest_hash=$3 WHERE owner_id=$1", [owner, run, digest]);
  try { expect((await get('contacts', c.token)).status).toBe(503); } finally { await admin.query("UPDATE career.maintenance_state SET state='ready',active_restore_run_id=NULL,manifest_hash=NULL WHERE owner_id=$1", [owner]); }
});
it('shares contact/resume writes between browser and agent with distinct audit actors', async () => {
  const c = await issue();
  const saved = await post({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: 'Ação fictícia', notes: 'Não enviou mensagem.', links: [] } }, c.token);
  expect(saved.status).toBe(201);
  expect((await get('contacts/' + saved.json.contact.id, c.token)).status).toBe(200);
  const contacts = await get('contacts'); expect(JSON.stringify(contacts.json).includes('Ação fictícia')).toBe(true);
  expect((await post({ operation: 'create_resume_ref', clientId: randomUUID(), data: { label: 'Versão fictícia', stack: [], language: 'Português', localRef: null } }, c.token)).status).toBe(201);
  const audit = (await admin.query('SELECT DISTINCT actor_kind,actor_id,source FROM career.audit_log WHERE owner_id=$1', [owner])).rows;
  expect(audit).toContainEqual({ actor_kind: 'agent', actor_id: c.id, source: 'agent' });
  expect(audit).toContainEqual({ actor_kind: 'owner', actor_id: owner, source: 'web' });
});
it('holds the credential lock until business commit before revocation completes', async () => {
  const c = await issue(); const actor = await authenticate(c.token);
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const work = database.transaction(actor, async tx => { entered(); await gate; return (await tx.query('SELECT current_user')).rows[0]!.current_user; }, undefined, 'career:read');
  await ready;
  let finished = false;
  const revoke = post({ operation: 'revoke_agent_credential', credential: { id: c.id, expectedVersion: 1 } }).then(result => { finished = true; return result; });
  let observedLock = false;
  try {
    for (let i = 0; i < 30; i++) {
      const waiting = (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='career_api' AND wait_event_type='Lock'")).rows[0].n;
      if (waiting) { observedLock = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(observedLock).toBe(true); expect(finished).toBe(false);
  } finally { release(); }
  expect(await work).toBe('career_api'); expect((await revoke).status).toBe(200);
  await expect(database.transaction(actor, async () => null, undefined, 'career:read')).rejects.toMatchObject({ status: 401 });
});
it('deduplicates cross-actor application identity with independent clientIds and retry keys', async () => {
  const c = await issue(); const jobCode = randomUUID();
  const save = () => ({ operation: 'save_application', clientId: randomUUID(), data: { opportunity: { company: 'Empresa fictícia', title: 'Engenharia', platform: 'fictional', tenant: 'fictional', jobCode, jobKey: null, kind: 'vaga', seniority: null, modality: null, description: null, stack: [], identities: [{ provider: 'fictional', tenant: 'fictional', kind: 'job_code', value: jobCode, verificationEvidence: null }] }, track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: unknownDate, stage: 'desconhecida', cycleRelation: 'unknown', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [], links: [] }, evidence: { clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Relato fictício de envio; não executei envio.', source: null, occurredDate: unknownDate, privateRef: null, localRef: null } });
  const [browser, agent] = await Promise.all([post(save()), post(save(), c.token)]);
  expect([200,201]).toContain(browser.status); expect([200,201]).toContain(agent.status);
  expect(browser.json.application.id).toBe(agent.json.application.id);
  expect((await post(save(), c.token)).json.application.id).toBe(browser.json.application.id);
  const rows = await admin.query('SELECT count(*)::int AS n FROM career.applications a JOIN career.opportunities o ON o.owner_id=a.owner_id AND o.id=a.opportunity_id WHERE a.owner_id=$1 AND o.job_code=$2', [owner, jobCode]);
  expect(rows.rows[0].n).toBe(1);
  const amended = await post({ operation: 'update_application', application: { id: browser.json.application.id, expectedVersion: browser.json.application.version }, changes: { notes: 'Anotação via agente.' } }, c.token);
  expect(amended.status).toBe(200);
  expect(JSON.stringify((await get('applications/' + browser.json.application.id)).json).includes('Anotação via agente.')).toBe(true);
  expect((await post({ operation: 'update_application', ownerId: owner, application: { id: browser.json.application.id, expectedVersion: 2 }, changes: { notes: 'Adulterado' } }, c.token)).status).toBe(400);
});
it('runs native CLI with UTF8 stdin bytes through real HTTP/PG without printing credentials', async () => {
  const c = await issue(['career:read','career:write']); const clientId = randomUUID(); const note = 'Ação, revisão e coração: não enviei mensagem.';
  const payload = { command: { operation: 'save_contact', target: { clientId }, data: { name: 'Contato fictício', notes: note, links: [] } }, idempotencyKey: randomUUID() };
  const invoke = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/agent-client.ts'], { windowsHide: true, env: { ...process.env, CAREER_AGENT_TOKEN: c.token.slice(7), CAREER_API_URL: `http://127.0.0.1:${api.port}` }, stdio: ['pipe','pipe','pipe'] });
    const output: Buffer[] = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk)); child.on('error', reject); child.on('close', code => resolve({ code, output: Buffer.concat(output).toString('utf8') }));
    child.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8'));
  });
  const first = await invoke(); const retry = await invoke();
  expect(first.code).toBe(0); expect(retry.code).toBe(0); expect(first.output).toBe(retry.output);
  expect(first.output.includes(c.token.slice(7))).toBe(false); expect(first.output.includes(c.hash)).toBe(false);
  const rows = await admin.query("SELECT c.notes FROM career.contacts c JOIN career.creation_requests r ON r.owner_id=c.owner_id AND r.result_contact_id=c.id WHERE c.owner_id=$1 AND r.client_id=$2", [owner, clientId]);
  expect(rows.rows).toHaveLength(1); expect(rows.rows[0].notes).toBe(note);
});
it('separates actual review write, JSON read and private Markdown export scopes', async () => {
  // Small valid disposable batch isolates permission behavior from the30-row CI timing fixture.
  const application = randomUUID(); const opportunity = randomUUID(); const cycle = randomUUID(); const batch = randomUUID();
  await admin.query('INSERT INTO career.opportunities(id,owner_id) VALUES($1,$2)', [opportunity, owner]);
  await admin.query("INSERT INTO career.applications(id,owner_id,opportunity_id,submission_status,cycle_relation,cycle_order) VALUES($1,$2,$3,'confirmado','after_reset',1)", [application, owner, opportunity]);
  await admin.query('INSERT INTO career.cycles(id,owner_id,is_current,next_order) VALUES($1,$2,true,2)', [cycle, owner]);
  await admin.query("INSERT INTO career.batches(id,owner_id,cycle_id,batch_number,status,target) VALUES($1,$2,$3,1,'pending',1)", [batch, owner, cycle]);
  await admin.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,1)', [owner, batch, application]);
  const reviewer = await issue(['career:reviews']); const reader = await issue(['career:read']); const exporter = await issue(['career:export']);
  const command = { operation: 'close_review', batch: { id: batch, expectedVersion: 1 }, narrative: 'Revisão fictícia.', decisions: [] };
  expect((await post(command, reader.token)).status).toBe(403);
  const closed = await post(command, reviewer.token); expect(closed.status).toBe(201);
  const path = 'reviews/' + closed.json.reviewId;
  expect((await get(path, reader.token)).status).toBe(200);
  expect((await get(path + '?format=markdown', reader.token)).status).toBe(403);
  const markdown = await get(path + '?format=markdown', exporter.token); expect(markdown.status).toBe(200); expect(markdown.text.includes('Revisão fictícia')).toBe(true);
  expect((await get(path, exporter.token)).status).toBe(403);
  expect((await get(path + '?format=other', exporter.token)).status).toBe(400);
});
