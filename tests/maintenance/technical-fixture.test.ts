import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import { runLocalDatabase, localDatabaseConfig, validateSecurityCatalog } from '../../scripts/local-db';
import { provisionOwner } from '../../scripts/provision-owner';
import { restorePrivate } from '../../scripts/restore-private';
import { createDatabase } from '../../server/database';
import { readServerConfig } from '../../server/config';
import { authenticateBearer, authenticateAgent } from '../../server/auth';
import { startApi } from '../helpers/api';
import { createExportService } from '../../server/services/exports';
import { readSnapshot } from '../../server/repositories/transfers';
import { canonicalJson } from '../../domain/export';
import { LEGACY_HEADER, parseLegacyCsv } from '../../domain/import';
import { reconcileCutoverFiles } from '../../scripts/cutover-check';
import { createLegacyPreview } from '../../scripts/import-legacy';

const human = 'Bearer fictional.owner.session';
const path = '/api/v1/maintenance/technical-fixture';
const unknownDate = {precision:'unknown',value:null};
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function inventory(client: pg.Client) {
  const rows: Record<string, string[]> = {};
  for (const name of tables) {
    rows[name] = (await client.query(`SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest
      FROM career.${name} t ORDER BY digest`)).rows.map(row => row.digest as string);
  }
  return rows;
}
async function seed(s: Fixture, run: string, maintenance: () => Promise<{status:number}>, agentMaintenance: (token:string) => Promise<{status:number}>,
  prefix: 'complete' | 'application_only' | 'revoked_initial' | 'revoked_agent' = 'complete') {
  const firstDispatch = s.commandKeys.length;
  const manifest = (attemptedKeys: string[]) => {
    assert.deepEqual(s.commandKeys.slice(firstDispatch),attemptedKeys);
    return attemptedKeys;
  };
  const client = randomUUID();
  const credential = randomUUID();
  const keys = Array.from({ length:6 }, () => randomUUID());
  const secret = randomBytes(32);
  const token = 'Bearer ct_agent_' + credential + '.' + secret.toString('base64url');
  const verifier = createHash('sha256').update(secret).digest('hex');
  secret.fill(0);
  const save = {operation:'save_application',clientId:client,data:{opportunity:{
    company:'Task 23 Fictional Company '+run,title:'Task 23 Fictional Role '+run,platform:null,tenant:null,
    jobCode:null,jobKey:null,kind:'vaga',seniority:null,modality:null,description:null,stack:[],identities:[]},
    track:null,applicationInstance:'initial',submissionStatus:'nao_enviado',submittedDate:unknownDate,stage:'desconhecida',
    cycleRelation:'unknown',discoveryChannel:null,submissionPlatform:null,notes:'Fictional Task 23 initial '+run,resumeIds:[],links:[]},evidence:null};
  const created = await s.post(save,keys[0]!);
  assert.equal(created.status,201);
  const application = created.json.application.id as string;
  const opportunity = created.json.application.opportunity.id as string;
  const appMapping = (await s.admin.query("SELECT id FROM career.creation_requests WHERE client_id=$1",[client])).rows[0].id as string;
  if (prefix==='application_only') return {application,opportunity,client,credential:null,keys:manifest([keys[0]!]),verifier,save,appMapping,credMapping:null};
  const mint = {operation:'create_agent_credential',clientId:credential,label:'Task 23 Fictional Agent '+run,
    prefix:credential.slice(0,8),tokenHash:verifier,scopes:['career:read','career:write'],
    expiresAt:new Date(Date.now()+(prefix==='revoked_initial' ? 1500 : 900_000)).toISOString()};
  assert.equal((await s.post(mint,keys[1]!)).status,201);
  const note = (version:number,who:string) => ({operation:'update_application',application:{id:application,expectedVersion:version},
    changes:{notes:'Fictional Task 23 '+who+' '+run},affectedBatches:[],evidence:null});
  if (prefix==='revoked_initial') {
    await delay(Math.max(0,Date.parse(mint.expiresAt)-Date.now())+30);
    assert.equal((await s.post(note(1,'agent'),keys[2]!,undefined,token)).status,401);
  } else {
    assert.equal((await s.post(note(1,'agent'),keys[2]!,undefined,token)).status,200);
    assert.equal((await agentMaintenance(token)).status,403);
    assert.equal((await maintenance()).status,403);
    if (prefix==='complete') {
      assert.equal((await s.post(note(1,'owner'),keys[3]!)).status,409);
      assert.equal((await s.post(note(2,'owner'),keys[4]!)).status,200);
    }
  }
  assert.equal((await s.post({operation:'revoke_agent_credential',credential:{id:credential,expectedVersion:1}},keys[5]!)).status,200);
  assert.equal((await s.getSettings(token)).status,401);
  const mapping = (await s.admin.query('SELECT entity_type,id FROM career.creation_requests')).rows;
  return {application,opportunity,client,credential,keys:manifest(prefix==='complete' ? keys : [keys[0]!,keys[1]!,keys[2]!,keys[5]!]),verifier,save,
    appMapping:mapping.find(row=>row.entity_type==='application').id as string,
    credMapping:mapping.find(row=>row.entity_type==='agent_credential').id as string};
}
const tables = ['agent_credentials','application_resumes','applications','audit_log','batch_members','batches',
  'contacts','creation_requests','cycles','events','evidence','import_rows','import_runs','links','maintenance_state',
  'mutation_keys','opportunities','opportunity_identities','owner_config','owner_settings','restore_row_ledger',
  'restore_runs','resume_refs','review_versions','source_files','tasks'];

async function fixture(t: TestContext, owner: string, restoreReady = false, managedCreator = false) {
  const name = 'career-maintenance-test-' + randomUUID();
  const password = randomBytes(32).toString('hex');
  const bootstrap = managedCreator ? 'supabase_admin' : 'postgres';
  const cid = execFileSync('docker', ['run','--detach','--name',name,'--publish','127.0.0.1::5432',
    '--env','POSTGRES_PASSWORD','--env','POSTGRES_USER='+bootstrap,'--env','POSTGRES_DB=career_tracker_test',
    'postgres@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7'],
    { encoding: 'utf8', env: { ...process.env, POSTGRES_PASSWORD: password } }).trim();
  assert.match(cid, /^[0-9a-f]{64}$/);
  // Apenas o ID completo devolvido pela criação desta fixture pode ser removido.
  t.after(() => { execFileSync('docker', ['rm','--force','--volumes',cid], { stdio: 'ignore' }); });
  const port = Number(execFileSync('docker', ['port',cid,'5432/tcp'], { encoding: 'utf8' }).trim().split(':')[1]);
  const url = new URL('postgresql://'+bootstrap+'@127.0.0.1:' + port + '/career_tracker_test');
  url.password = password;
  const admin = new pg.Client(localDatabaseConfig(url.href));
  admin.on('error', () => {});
  for (let i = 0; i < 200; i++) {
    if (i === 199) throw Error('PostgreSQL descartável indisponível.');
    try { execFileSync('docker',['exec',cid,'pg_isready','-h','127.0.0.1','-d','career_tracker_test'], {stdio:'ignore'}); break; }
    catch { await delay(100); }
  }
  await admin.connect();
  if (restoreReady) await runLocalDatabase('apply',url.href);
  else {
    const dir = new URL('../../supabase/migrations/',import.meta.url);
    const migrations = (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort();
    const current = migrations.pop()!;
    assert.match(current,/audited_technical_fixture_maintenance\.sql$/);
    const roles = ['career_api','career_restore','career_audit_writer','career_schema_owner'];
    let creator: pg.Client | undefined;
    if (managedCreator) {
      // Apenas o cluster descartável recém-criado tem esta identidade de bootstrap.
      const localPassword=randomBytes(32).toString('hex');
      await admin.query('CREATE ROLE postgres LOGIN CREATEROLE BYPASSRLS INHERIT PASSWORD '+pg.escapeLiteral(localPassword));
      await admin.query('GRANT CREATE ON DATABASE career_tracker_test TO postgres');
      creator = new pg.Client({...localDatabaseConfig(url.href),user:'postgres',password:localPassword});
      await creator.connect();
      assert.deepEqual((await creator.query(`SELECT session_user,current_user,current_setting('createrole_self_grant') AS self_grant,
        rolsuper,rolinherit,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0],
        {session_user:'postgres',current_user:'postgres',self_grant:'',rolsuper:false,rolinherit:true,rolcreaterole:true,rolbypassrls:true});
      for (const role of roles) await creator.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    }
    for (const name of migrations) await admin.query(await readFile(new URL(name,dir),'utf8'));
    if (!managedCreator) {
      await admin.query('CREATE ROLE fictional_installer NOLOGIN');
      for (const role of roles)
        await admin.query(`GRANT ${role} TO fictional_installer WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
    }
    const originalAuthority = async () => (await admin.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.oid) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
        WHERE member=$1::regrole AND r.rolname=ANY($2)) AS memberships,
      (SELECT jsonb_agg(to_jsonb(r)-'rolpassword' ORDER BY r.oid) FROM pg_roles r WHERE rolname IN
        ('career_api','career_restore','career_audit_writer','career_schema_owner')) AS roles,
      (SELECT pg_get_functiondef('career.audit_business_change()'::regprocedure)) AS audit`,
      [managedCreator?'postgres':'fictional_installer',roles])).rows[0];
    const original = await originalAuthority();
    assert.equal(original.memberships.length,4);
    const candidate = await readFile(new URL(current,dir),'utf8');
    const creatorTuple = async () => (await admin.query(`SELECT m.oid AS id, r.rolname AS member, g.rolname AS grantor,
      m.admin_option,m.inherit_option,m.set_option,pg_has_role(r.oid,m.roleid,'USAGE') AS uses_role,
      pg_has_role(r.oid,m.roleid,'SET') AS sets_role FROM pg_auth_members m JOIN pg_roles r ON m.member=r.oid
      JOIN pg_roles g ON g.oid=m.grantor WHERE m.roleid='career_fixture_executor'::regrole`)).rows;
    let before: pg.QueryResultRow[] = [];
    if (creator) {
      try {
        await creator.query('CREATE ROLE career_fixture_executor NOLOGIN NOINHERIT NOBYPASSRLS');
        before=await creatorTuple();
        assert.equal(before.length,1);
        assert.deepEqual(before[0],{id:before[0]!.id,member:'postgres',grantor:'supabase_admin',admin_option:true,
          inherit_option:false,set_option:false,uses_role:false,sets_role:false});
        await assert.rejects(creator.query('SET ROLE career_fixture_executor'),{code:'42501'});
        await assert.rejects(creator.query('SET ROLE career_schema_owner'),{code:'42501'});
        await creator.query('BEGIN');
        try {
          await assert.rejects(creator.query(candidate),(error: Error & {code?:string}) => {
            assert.equal(error.code,'42501');
            const kind = error.message.includes('schema career') ? 'core schema' : error.message.includes('owner of table') ? 'table ownership' : 'DDL authority';
            t.diagnostic('PostgreSQL refused standalone installer at '+kind+' (42501).');
            return true;
          });
        }
        finally { await creator.query('ROLLBACK'); }
        assert.equal((await admin.query("SELECT to_regnamespace('career_maintenance') AS schema")).rows[0].schema,null);
      } finally { await creator.end(); }
      // Uma ACL extra, mesmo que redundante com o privilégio público, impede a adoção.
      await admin.query('BEGIN');
      try {
        await admin.query('GRANT USAGE ON SCHEMA public TO career_fixture_executor');
        await assert.rejects(admin.query(candidate),{code:'P0001'});
      } finally { await admin.query('ROLLBACK'); }
      await admin.query('BEGIN');
      try {
        await admin.query('CREATE ROLE fictional_observer NOLOGIN');
        await admin.query('GRANT career_fixture_executor TO fictional_observer WITH ADMIN FALSE, INHERIT FALSE, SET FALSE');
        await assert.rejects(admin.query(candidate),{code:'P0001'});
      } finally { await admin.query('ROLLBACK'); }
    }
    await admin.query(candidate);
    if (managedCreator) assert.deepEqual(await creatorTuple(),before);
    assert.deepEqual(await originalAuthority(),original);
    await validateSecurityCatalog(admin);
  }
  const apiPassword = randomBytes(32).toString('hex');
  const restorePassword = randomBytes(32).toString('hex');
  await provisionOwner({adminUrl:url.href,ownerId:owner,apiPassword,restorePassword,restoreReady});
  url.username = 'career_api'; url.password = apiPassword;
  const config = readServerConfig({NODE_ENV:'test',DATABASE_URL:url.href,DATABASE_TLS:'disable-local',
    OWNER_USER_ID:owner,SUPABASE_URL:'http://127.0.0.1',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test'});
  const db = createDatabase(config);
  const ownerAuth = (header: string | undefined) => authenticateBearer(header,config,{
    getUser: async token => ({data:{user: human === 'Bearer ' + token ? {id:owner} : null},error:null}),
  });
  const commandKeys: (string | string[] | undefined)[] = [];
  const api = await startApi({database:db, authenticate: header => header?.startsWith('Bearer ct_agent_')
    ? authenticateAgent(header,config,db) : ownerAuth(header), logger: () => {}}, request => {
    if (request.method === 'POST' && new URL(request.url!, 'http://localhost').pathname === '/api/v1/commands')
      commandKeys.push(request.headers['idempotency-key']);
  });
  const getSettings = (authorization: string) => api.request('/api/v1/settings',{headers:{authorization}});
  const post = (body:unknown,key: string,endpoint='/api/v1/commands',authorization=human) =>
    api.request(endpoint,{method:'POST',headers:{authorization,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
  url.username = 'career_restore'; url.password = restorePassword;
  return {admin,post,getSettings,commandKeys,db,ownerAuth,apiConfig:config.database,restoreConfig:localDatabaseConfig(url.href),
    async close() { await api.close(); await db.close(); await admin.end(); }};
}

test('a atribuição longa do legado sobrevive à importação, exportação e restauração', async t => {
  const owner = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'career-source-projection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await fixture(t, owner, true);
  t.after(() => source.close());
  const actor = await source.ownerAuth(human);
  const exports = createExportService(source.db);
  const role = await source.db.transaction(actor, async (tx) => (await tx.query(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]);
  assert.deepEqual(role, { rolname: 'career_api', rolsuper: false, rolbypassrls: false });
  const attribution = '  Origem fictícia, com "aspas" e\r\nquebra de linha. '.padEnd(642, 'á');
  const boundary = 'Fonte no limite fictício. '.padEnd(500, 'a');
  const normal = '  Fonte fictícia  ';
  const csvRow = (id: string, value: string) => [id, 'Empresa fictícia', 'Vaga fictícia', 'Portal fictício', '', '',
    '', '', 'confirmado', '', 'Relato fictício', '', '', '', value, '', '']
    .map((field) => '"' + field.replaceAll('"', '""') + '"').join(',') + '\r\n';
  const legacyIds = ['V920', 'V921', 'V922'];
  const rawRows = [attribution, boundary, normal].map((value, i) => csvRow(legacyIds[i]!, value));
  const csv = Buffer.from(LEGACY_HEADER.join(',') + '\r\n' + rawRows.join(''));
  const sourceDir = await mkdtemp(join(directory, 'source-'));
  const privateDir = await mkdtemp(join(directory, 'private-'));
  await writeFile(join(sourceDir, 'ficticio.csv'), csv);
  const preview = await createLegacyPreview({ sourceDir, privateDir, files: ['ficticio.csv'] });
  const apply = (unit: string, data: unknown, key = randomUUID()) => source.post({ unit, data }, key, '/api/v1/imports/apply');
  const prepare = { manifest: preview.manifest, sources: [{ name: 'ficticio.csv', bytesBase64: csv.toString('base64') }],
    cycle: { id: randomUUID(), expectedVersion: null, resetDate: unknownDate, resetMarker: null, isCurrent: true } };
  const prepared = await apply('prepare', prepare);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.json));
  const runId: unknown = prepared.json.runId;
  assert.ok(typeof runId === 'string');
  const interpretation = { track: null, applicationInstance: 'ficticia', cycleRelation: 'unknown', kind: 'desconhecido', provider: null, tenant: null };
  const request = (legacyId: string) => ({ runId, legacyId, expectedVersion: null, expectedOpportunityVersion: null, interpretation, decisions: null });
  const applicationResponses: { applicationId: string; version: number; result: 'imported' }[] = [];
  for (const legacyId of legacyIds) {
    const response = await apply('application', request(legacyId));
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const { applicationId, version, result } = response.json;
    assert.ok(typeof applicationId === 'string');
    assert.equal(version, 1);
    assert.equal(result, 'imported');
    applicationResponses.push({ applicationId, version, result });
  }
  const complete = await apply('complete', { runId, reviewRequired: false });
  assert.equal(complete.status, 200, JSON.stringify(complete.json));
  const snapshot = await exports.json(actor);
  const evidence = snapshot.entities.flatMap((entity) => entity.table === 'evidence' ? [entity.data] : []);
  const events = snapshot.entities.flatMap((entity) => entity.table === 'events' ? [entity.data] : []);
  const rows = snapshot.entities.flatMap((entity) => entity.table === 'import_rows' ? [entity.data] : []);
  const warning = 'unprojected_source_attribution';
  assert.equal(preview.manifest.parsed.issues.some(({ code }) => code === warning), false);
  assert.equal(snapshot.entities.some((entity) => entity.table === 'import_runs' && entity.data.pendingIssues.includes(warning)), false);
  for (const [i, raw] of rawRows.entries()) {
    const legacyId = legacyIds[i];
    const result = applicationResponses[i]!;
    const app = snapshot.entities.find((entity) => entity.table === 'applications' && entity.data.id === result.applicationId);
    const stored = evidence.find((entry) => entry.originalText === raw);
    const importRow = rows.find((entry) => entry.legacyId === legacyId);
    assert.equal(app?.table, 'applications');
    assert.equal(app.data.legacyId, legacyId);
    assert.equal(app.data.displayId, legacyId);
    assert.deepEqual(app.data.submittedDate, unknownDate);
    assert.ok(stored);
    assert.equal(stored.source, [null, boundary, normal][i]);
    assert.deepEqual(stored.occurredDate, unknownDate);
    assert.equal(importRow?.originalText, raw);
    assert.equal(importRow.pendingIssues.filter((code) => code === warning).length, i === 0 ? 1 : 0);
    const confirmations = events.filter((event) => event.applicationId === result.applicationId && event.kind === 'envio_confirmado');
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0]?.evidenceId, stored.id);
    assert.deepEqual(confirmations[0]?.occurredDate, unknownDate);
  }
  const archived = snapshot.entities.find((entity) => entity.table === 'source_files');
  assert.equal(archived?.table, 'source_files');
  assert.deepEqual(Buffer.from(archived.data.originalBytesBase64, 'base64'), csv);
  assert.equal(archived.data.originalText, csv.toString('utf8'));
  const exportedCsv = parseLegacyCsv(await exports.csv(actor));
  assert.equal(exportedCsv.blocked, false);
  assert.equal(exportedCsv.rows.find((row) => row.legacyId === legacyIds[0])?.source, attribution);

  // Uma chave HTTP nova atravessa o controle de replay da própria unidade.
  const replay = await apply('application', request(legacyIds[0]!));
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.deepEqual(replay.json, applicationResponses[0]);
  assert.deepEqual((await exports.json(actor)).entities, snapshot.entities);

  const exportFile = join(directory, 'export.json');
  const check = async (snapshotToCheck: typeof snapshot, manifestDirectory = preview.directory) => {
    await writeFile(exportFile, canonicalJson(snapshotToCheck));
    const result = await reconcileCutoverFiles(join(manifestDirectory, 'manifest.json'), exportFile);
    assert.equal(result.exitCode, 0, JSON.stringify(result.discrepancies));
    return result.counts;
  };
  assert.equal((await check(snapshot)).atribuicoes_de_fonte_preservadas_no_original, 1);
  const destination = await fixture(t, owner, true);
  t.after(() => destination.close());
  const restored = await restorePrivate({ actor, ownerId: owner, database: destination.restoreConfig, snapshot, mode: 'apply' });
  assert.equal(restored.state, 'completed');
  const copy = await createExportService(destination.db).json(actor);
  assert.deepEqual(copy.entities.filter((entity) => !(entity.table === 'audit_log' && entity.data.id === restored.runId)), snapshot.entities);
  assert.equal((await check(copy)).atribuicoes_de_fonte_preservadas_no_original, 1);

  // Atribuição já aplicada fica no baseline da linha que o novo lote pula.
  const nextRows = [rawRows[0]!, csvRow(legacyIds[1]!, attribution), csvRow(legacyIds[2]!, attribution)];
  const deltaCsv = Buffer.from(LEGACY_HEADER.join(',') + '\r\n' + nextRows.join(''));
  await writeFile(join(sourceDir, 'ficticio.csv'), deltaCsv);
  const delta = await createLegacyPreview({ sourceDir, privateDir, files: ['ficticio.csv'] });
  const cycle = snapshot.entities.find((entity) => entity.table === 'cycles');
  assert.equal(cycle?.table, 'cycles');
  const deltaPrepared = await apply('prepare', { ...prepare, manifest: delta.manifest,
    sources: [{ name: 'ficticio.csv', bytesBase64: deltaCsv.toString('base64') }],
    cycle: { ...prepare.cycle, expectedVersion: cycle.data.version } });
  assert.equal(deltaPrepared.status, 200, JSON.stringify(deltaPrepared.json));
  const deltaRunId: unknown = deltaPrepared.json.runId;
  assert.ok(typeof deltaRunId === 'string');
  for (const [i, legacyId] of legacyIds.entries()) {
    const decisions = i === 0 ? null : Object.fromEntries(LEGACY_HEADER.map((column) =>
      [column, column === 'evidencia_envio' || column === 'fonte' && i === 1 ? 'source' : 'current']));
    const response = await apply('application', { ...request(legacyId), runId: deltaRunId, decisions,
      expectedVersion: decisions ? 1 : null, expectedOpportunityVersion: decisions ? 1 : null });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.result, i === 0 ? 'skipped' : 'imported');
    assert.equal(response.json.applicationId, applicationResponses[i]!.applicationId);
  }
  const deltaComplete = await apply('complete', { runId: deltaRunId, reviewRequired: false });
  assert.equal(deltaComplete.status, 200, JSON.stringify(deltaComplete.json));
  const reconciled = await exports.json(actor);
  const deltaFile = reconciled.entities.find((entity) => entity.table === 'source_files' && entity.data.importRunId === deltaRunId);
  assert.equal(deltaFile?.table, 'source_files');
  const deltaSourceFileId = deltaFile.data.id;
  const deltaRows = reconciled.entities.flatMap((entity) => entity.table === 'import_rows' && entity.data.sourceFileId === deltaSourceFileId ? [entity.data] : []);
  for (const [i, raw] of nextRows.entries()) {
    const entry = deltaRows.find((row) => row.originalText === raw);
    assert.ok(entry);
    assert.equal(entry.pendingIssues.includes(warning), i === 1);
    const matches = reconciled.entities.flatMap((entity) => entity.table === 'evidence' && entity.data.originalText === raw ? [entity.data] : []);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.source, null);
  }
  const counts = await check(reconciled, delta.directory);
  assert.equal(counts.atribuicoes_de_fonte_preservadas_no_original, 2);
  assert.equal(counts.reaplicacoes_com_baseline, 1);
  assert.equal(counts.textos_por_decisao_somente_no_original, 1);
});

test('a rota normalizada de manutenção recusa o agente antes da autenticação', async t => {
  const config = {ownerUserId:randomUUID(),supabaseUrl:'http://127.0.0.1',supabasePublishableKey:'sb_publishable_test',
    database:{host:'127.0.0.1',port:1}};
  const database = createDatabase(config);
  const lookup = t.mock.method(database,'lookupAgentCredential',async () => null);
  const authenticate = t.mock.fn((header: string | undefined) => authenticateAgent(header,config,database));
  const api = await startApi({database,authenticate,logger:() => {}});
  const headers = {authorization:'Bearer ct_agent_'+randomUUID()+'.'+randomBytes(32).toString('base64url')};
  try {
    for (const target of [path, '/api/v1/maintenance/./technical-fixture',
      '/api/v1/commands/../maintenance/technical-fixture', '/api/v1/maintenance/%2e/technical-fixture?test=1']) {
      const refusal = await api.request(target,{method:'POST',headers});
      assert.equal(refusal.status,403);
      assert.equal(refusal.json.error.code,'FORBIDDEN');
    }
    assert.equal(authenticate.mock.callCount(),0);
    assert.equal(lookup.mock.callCount(),0);
    assert.equal((await api.request('/api/v1/settings',{headers})).status,401);
    assert.equal(authenticate.mock.callCount(),1);
    assert.equal(lookup.mock.callCount(),1);
  } finally {
    await api.close();
    await database.close();
  }
});

test('remoção autorizada preserva o histórico e a restauração independente', async t => {
  const owner = randomUUID();
  const run = randomUUID();
  const approvalId = randomUUID();
  const packageHash = createHash('sha256').update('pacote fictício revisado').digest('hex');
  let key: string = randomUUID();
  const cmd: { approvalId:string;runId:string;packageHash:string } = { approvalId, runId:run, packageHash };
  const s = await fixture(t,owner);
  try {
    const invoke = () => s.post(cmd,key,path);
    const missing = await invoke();
    assert.equal(missing.status,403);
    assert.equal((await s.post({...cmd,source:'maintenance'},key,path)).status,400);
    assert.equal((await s.post(cmd,key,path,'Bearer fictional.other.session')).status,401);
    const f = await seed(s,run,invoke,token => s.post(cmd,key,path,token));
    const { admin } = s;
    const original = await inventory(admin);
    assert.equal(Object.values(original).flat().length,20);
    const baseline = async () => {
      await admin.query('BEGIN');
      try {
        await admin.query('SELECT pg_advisory_xact_lock(1128354386,1)');
        return (await admin.query('SELECT career_maintenance.baseline($1) AS hash',[run])).rows[0].hash as string;
      } finally { await admin.query('ROLLBACK'); }
    };
    const hash = await baseline();
    const issue = async (options: {id?:string;key?:string;digest?:string;mapping?:string;seconds?:number;age?:number} = {}) => {
      const id = options.id ?? randomUUID(), ticketKey = options.key ?? randomUUID();
      await admin.query(`INSERT INTO career_maintenance.approvals(id,owner_id,run_id,package_hash,baseline_hash,
        expires_at,command_key,application_id,opportunity_id,credential_id,application_client_id,application_mapping_id,
        credential_mapping_id,attempted_keys,prefix,display_id,issued_at) VALUES($1,$2,$3,$4,$5,
        clock_timestamp()+$6*interval '1 second',$7,$8,$9,$10,$11,$12,$13,$14,'complete','N000001',clock_timestamp()-$15*interval '1 second')`,
        [id,owner,run,packageHash,options.digest??hash,options.seconds??1000,ticketKey,f.application,f.opportunity,
          f.credential,f.client,f.appMapping,options.mapping??f.credMapping,f.keys,options.age??0]);
      return {id,key:ticketKey,invoke:()=>s.post({approvalId:id,runId:run,packageHash},ticketKey,path)};
    };
    const first = await issue({id:approvalId,key});
    await assert.rejects(admin.query('UPDATE career_maintenance.approvals SET expires_at=expires_at WHERE id=$1',[approvalId]),{code:'42501'});
    const unchanged = async () => {
      assert.deepEqual(await inventory(admin),original);
      assert.equal((await admin.query('SELECT 1 FROM career_maintenance.outcomes')).rowCount,0);
    };
    const runtime = new pg.Client(s.apiConfig);
    await runtime.connect();
    try {
      for (const table of ['creation_requests','applications','opportunities','agent_credentials'])
        await assert.rejects(runtime.query(`DELETE FROM career.${table} WHERE false`),{code:'42501'});
      for (const sql of ['SET ROLE career_fixture_executor','SET ROLE career_schema_owner',
        'UPDATE career_maintenance.approvals SET expires_at=expires_at WHERE false',
        'INSERT INTO career_maintenance.approvals DEFAULT VALUES','SELECT * FROM career_maintenance.approvals',
        'INSERT INTO career_maintenance.outcomes DEFAULT VALUES','SELECT career_maintenance.baseline(gen_random_uuid())',
        'SELECT career_maintenance.lock_approval()'])
        await assert.rejects(runtime.query(sql),{code:'42501'});
      await runtime.query('BEGIN');
      await runtime.query('SELECT pg_advisory_xact_lock_shared(1128354386,1)');
      await admin.query('BEGIN');
      await admin.query('LOCK TABLE career.owner_config IN ACCESS EXCLUSIVE MODE');
      try {
        const busy = await invoke();
        assert.equal(busy.json.error.code,'MAINTENANCE');
      } finally { await admin.query('ROLLBACK'); await runtime.query('ROLLBACK'); }
      await admin.query('BEGIN');
      await admin.query('LOCK TABLE career.tasks IN ROW EXCLUSIVE MODE');
      try { assert.equal((await invoke()).status,503); } finally { await admin.query('ROLLBACK'); }
      await unchanged();
      const expired = await issue({seconds:-60,age:300});
      assert.equal((await expired.invoke()).status,403);
      await admin.query("ALTER ROLE career_restore CONNECTION LIMIT 2");
      try { assert.equal((await invoke()).json.error.code,'FIXTURE_CHANGED'); }
      finally { await admin.query("ALTER ROLE career_restore CONNECTION LIMIT -1"); }
      await admin.query('BEGIN');
      let otherOids: string;
      try {
        await admin.query('REVOKE career_restore FROM fictional_installer');
        await admin.query('GRANT career_restore TO fictional_installer WITH ADMIN TRUE, INHERIT FALSE, SET FALSE');
        await admin.query('SELECT pg_advisory_xact_lock(1128354386,1)');
        otherOids = (await admin.query('SELECT career_maintenance.baseline($1) AS hash',[run])).rows[0].hash;
      } finally { await admin.query('ROLLBACK'); }
      assert.notEqual(otherOids!,hash);
      const wrongOids = await issue({digest:otherOids!});
      assert.equal((await wrongOids.invoke()).json.error.code,'FIXTURE_CHANGED');
      await admin.query("ALTER ROLE career_api IN DATABASE career_tracker_test SET work_mem='6MB'");
      try {
        assert.notEqual(await baseline(),hash);
        assert.equal((await invoke()).json.error.code,'FIXTURE_CHANGED');
      } finally { await admin.query('ALTER ROLE career_api IN DATABASE career_tracker_test RESET work_mem'); }
      assert.equal(await baseline(),hash);
      await admin.query("ALTER ROLE career_api IN DATABASE postgres SET work_mem='6MB'");
      try { assert.equal(await baseline(),hash); }
      finally { await admin.query('ALTER ROLE career_api IN DATABASE postgres RESET work_mem'); }
      await admin.query('CREATE RULE technical_test_rule AS ON UPDATE TO career.tasks DO ALSO NOTIFY synthetic_task_update');
      try { assert.notEqual(await baseline(),hash,'a impressão do catálogo inclui regras de reescrita'); }
      finally { await admin.query('DROP RULE technical_test_rule ON career.tasks'); }
      await admin.query('CREATE TABLE public.technical_test_child () INHERITS (career.tasks)');
      try { await assert.rejects(baseline(),{code:'P0412'}); }
      finally { await admin.query('DROP TABLE public.technical_test_child'); }
      await admin.query('CREATE INDEX technical_test_catalog_drift ON career.tasks (id,title)');
      try { assert.equal((await invoke()).json.error.code,'FIXTURE_CHANGED'); }
      finally { await admin.query('DROP INDEX career.technical_test_catalog_drift'); }
      await admin.query('UPDATE career.owner_settings SET daily_goal=daily_goal+1');
      try { assert.equal((await invoke()).json.error.code,'FIXTURE_CHANGED'); }
      finally { await admin.query('UPDATE career.owner_settings SET daily_goal=daily_goal-1'); }
      await admin.query("INSERT INTO career.contacts(owner_id,name) VALUES($1,'Fictício')",[randomUUID()]);
      try { assert.equal((await invoke()).json.error.code,'FIXTURE_CHANGED'); }
      finally { await admin.query("DELETE FROM career.contacts WHERE name='Fictício'"); }
      const linkId = randomUUID();
      await admin.query("INSERT INTO career.links(id,owner_id,application_id,original_url,kind) VALUES($1,$2,$3,'https://example.invalid','fictício')",[linkId,owner,f.application]);
      try { assert.equal((await invoke()).json.error.code,'FIXTURE_CHANGED'); }
      finally { await admin.query('DELETE FROM career.links WHERE id=$1',[linkId]); }
      await admin.query("UPDATE career.audit_log SET source='alterada' WHERE source='provisioning'");
      try { assert.equal((await invoke()).json.error.code,'FIXTURE_CHANGED'); }
      finally { await admin.query("UPDATE career.audit_log SET source='provisioning' WHERE source='alterada'"); }
      await admin.query("UPDATE career.agent_credentials SET token_hash=repeat('a',64)");
      try { assert.equal((await invoke()).json.error.code,'FIXTURE_CHANGED'); }
      finally { await admin.query('UPDATE career.agent_credentials SET token_hash=$1',[f.verifier]); }
      const wrongMapping = await issue({mapping:randomUUID()});
      assert.equal((await wrongMapping.invoke()).json.error.code,'FIXTURE_CHANGED');
      await unchanged();
      const revoked = (await admin.query('SELECT revoked_at::text AS instant FROM career.agent_credentials')).rows[0].instant;
      await admin.query('UPDATE career.agent_credentials SET revoked_at=NULL');
      try {
        const liveCredential = await issue({digest:await baseline()});
        assert.equal((await liveCredential.invoke()).json.error.code,'FIXTURE_CHANGED');
      } finally {
        await admin.query('UPDATE career.agent_credentials SET revoked_at=$1',[revoked]);
      }
      await unchanged();
      const finiteExpiry = (await admin.query('SELECT expires_at::text AS instant FROM career.agent_credentials WHERE id=$1',[f.credential])).rows[0].instant;
      await admin.query("UPDATE career.agent_credentials SET expires_at='infinity' WHERE id=$1",[f.credential]);
      try {
        const infiniteCredential = await issue({digest:await baseline()});
        const refusal = await infiniteCredential.invoke();
        assert.equal(refusal.status,409);
        assert.equal(refusal.json.error.code,'FIXTURE_CHANGED');
      } finally {
        await admin.query('UPDATE career.agent_credentials SET expires_at=$1 WHERE id=$2',[finiteExpiry,f.credential]);
      }
      await unchanged();
      // O bloqueio da última escrita permite observar a transação HTTP real antes do rollback.
      await admin.query('BEGIN');
      await admin.query('LOCK TABLE career_maintenance.outcomes IN SHARE MODE');
      let lockCount = 0;
      try {
        const late = invoke();
        for (let i=0; i<80; i++) {
          lockCount = (await runtime.query(`SELECT count(DISTINCT l.relation)::int AS n FROM pg_locks l
            JOIN pg_class c ON c.oid=l.relation WHERE l.granted AND l.mode='ExclusiveLock' AND c.relnamespace='career'::regnamespace
            AND l.pid IN (SELECT pid FROM pg_locks WHERE NOT granted AND relation='career_maintenance.outcomes'::regclass)`)).rows[0].n;
          if (lockCount===26) break;
          await delay(15);
        }
        assert.equal((await late).status,503);
      } finally { await admin.query('ROLLBACK'); }
      assert.equal(lockCount,26);
      await unchanged();
      // Expiração entre as exclusões e a emissão da evidência final.
      const short = await issue({seconds:1});
      await admin.query('BEGIN');
      await admin.query('LOCK TABLE career_maintenance.outcomes IN SHARE MODE');
      const expiring = short.invoke();
      await delay(1100);
      await admin.query('ROLLBACK');
      assert.equal((await expiring).status,403);
      await unchanged();
      const final = await issue({seconds:3});
      cmd.approvalId=final.id;
      key=final.key;
      const result = await invoke();
      assert.equal(result.status,200, JSON.stringify(result.json.error));
      assert.deepEqual(result.json,{runId:run,requestId:result.headers['x-request-id'],applicationId:f.application,
        opportunityId:f.opportunity,credentialId:f.credential,applicationMappingId:f.appMapping,credentialMappingId:f.credMapping});
      const after = await inventory(admin);
      assert.equal(Object.values(after).flat().length,19);
      assert.equal(after.audit_log!.length,10);
      assert.equal(after.mutation_keys!.length,6);
      for (const [table,previous] of Object.entries(original)) {
        if (['applications','opportunities','agent_credentials','creation_requests'].includes(table)) assert.deepEqual(after[table],[]);
        else for (const row of previous) assert.ok(after[table]!.includes(row));
      }
      const audits = (await admin.query('SELECT * FROM career.audit_log WHERE request_id=$1',[result.json.requestId])).rows;
      assert.equal(audits.length,3);
      for (const row of audits) {
        assert.equal(row.actor_kind,'owner'); assert.equal(row.actor_id,owner); assert.equal(row.source,'maintenance');
        assert.equal(row.operation,'delete'); assert.equal(row.after_data,null);
      }
      assert.equal(JSON.stringify([result.json,audits]).includes(f.verifier),false);
      assert.equal(JSON.stringify([result.json,audits]).includes('token_hash'),false);
      assert.equal((await s.post(cmd,randomUUID(),path)).status,403);
      assert.equal((await first.invoke()).status,403);
      await assert.rejects(admin.query('DELETE FROM career_maintenance.outcomes'),{code:'42501'});
      assert.equal((await admin.query('SELECT 1 FROM career_maintenance.approvals')).rowCount,8);
      await admin.query('SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp()))+0.05) FROM career_maintenance.approvals WHERE id=$1',[final.id]);
      assert.deepEqual((await invoke()).json,result.json);
      assert.equal((await s.post({...cmd,packageHash:'a'.repeat(64)},key,path)).status,409);
      assert.equal((await s.post(cmd,randomUUID(),path)).status,403);
      assert.equal((await admin.query('SELECT 1 FROM career_maintenance.outcomes')).rowCount,1);
      assert.deepEqual(await inventory(admin),after);
      assert.deepEqual((await admin.query('SELECT last_value::int,is_called FROM career.application_display_sequence')).rows[0],
        {last_value:1,is_called:true});
      // O conflito da chave aposentada ocorre na reserva, antes da escrita de negócio.
      assert.equal((await s.post({...f.save,clientId:randomUUID()},f.keys[3]!)).status,409);
      assert.deepEqual(await inventory(admin),after);
      const actor = await s.ownerAuth(human);
      const snapshot = await createExportService(s.db).json(actor);
      assert.equal(snapshot.entities.filter(row=>row.table==='audit_log').length,10);
      assert.equal(JSON.stringify(snapshot).includes(f.verifier),false);
      const destination = await fixture(t,owner,true);
      try {
        const restored = await restorePrivate({actor,ownerId:owner,database:destination.restoreConfig,snapshot,mode:'apply'});
        assert.equal(restored.state,'completed');
        const back = await createExportService(destination.db).json(actor);
        assert.deepEqual(back.entities.filter(row=>!(row.table==='audit_log' && row.data.id===restored.runId)),snapshot.entities);
        assert.equal(back.entities.filter(row=>row.table==='audit_log').length,11);
        for (const name of ['approvals','outcomes'])
          assert.equal((await destination.admin.query(`SELECT 1 FROM career_maintenance.${name}`)).rowCount,0);
        assert.equal((await destination.admin.query('SELECT 1 FROM career.mutation_keys')).rowCount,0);
        assert.equal((await destination.post(cmd,key,path)).status,403);
      } finally { await destination.close(); }
    } finally { await runtime.end(); }
  } finally { await s.close(); }
});

test('a prévia e a ativação preservam a auditoria opaca e conferem a capacidade da sequência', async t => {
  const owner = randomUUID();
  const source = await fixture(t,owner,true);
  const destination = await fixture(t,owner,true);
  try {
    const actor = await source.ownerAuth(human);
    const options = {actor,ownerId:owner,database:destination.restoreConfig};
    const auditId = randomUUID();
    const before = {display_id:'N92233720368547758080',notes:'histórico original'};
    const after = {display_id:'N9223372036854775806'};
    const insertAudit = (id:string, beforeData:unknown, afterData:unknown) => source.admin.query(
      `INSERT INTO career.audit_log(id,owner_id,actor_kind,actor_id,source,entity_type,entity_id,operation,before_data,after_data,diff,request_id)
       VALUES($1,$2,'owner',$2::uuid::text,'fixture','applications',$3,'update',$4,$5,'{}',$6)`,
      [id,owner,randomUUID(),beforeData,afterData,randomUUID()]);
    await insertAudit(auditId,before,after);
    const eligible = await createExportService(source.db).json(actor);
    const bootstrap = await inventory(destination.admin);
    const expectHold = async (snapshot: typeof eligible) => {
      assert.equal((await restorePrivate({...options,snapshot,mode:'preview'})).state,'preview-sequence-exhausted');
      await assert.rejects(restorePrivate({...options,snapshot,mode:'apply'}),/sequência de candidaturas está esgotada/);
      assert.deepEqual(await inventory(destination.admin),bootstrap);
    };
    await source.admin.query('BEGIN');
    try {
      await insertAudit(randomUUID(),null,{display_id:'N9223372036854775807'});
      await expectHold(await readSnapshot(source.admin,owner));
    } finally { await source.admin.query('ROLLBACK'); }
    await source.admin.query("SELECT setval('career.application_display_sequence',9223372036854775807,true)");
    const exhausted = await createExportService(source.db).json(actor);
    assert.equal(exhausted.manifest.continuity?.displayHighWater,'9223372036854775807');
    await expectHold(exhausted);
    assert.equal((await restorePrivate({...options,snapshot:eligible,mode:'preview'})).state,'preview');
    assert.equal((await restorePrivate({...options,snapshot:eligible,mode:'apply'})).state,'completed');
    const copy = await createExportService(destination.db).json(actor);
    assert.deepEqual(copy.entities.find(row=>row.data.id===auditId),eligible.entities.find(row=>row.data.id===auditId));
    assert.equal(copy.manifest.continuity?.displayHighWater,'9223372036854775806');
    const last = await destination.db.transaction(actor,async tx=>{
      const opportunity = await tx.query('INSERT INTO career.opportunities(owner_id) VALUES($1) RETURNING id',[owner]);
      return (await tx.query('INSERT INTO career.applications(owner_id,opportunity_id) VALUES($1,$2) RETURNING display_id',
        [owner,opportunity.rows[0]?.id])).rows[0]?.display_id;
    });
    assert.equal(last,'N9223372036854775807');
    const full = await createExportService(destination.db).json(actor);
    assert.ok(full.entities.some(row=>row.table==='applications' && row.data.displayId===last));
    assert.equal(full.manifest.continuity?.displayHighWater,'9223372036854775807');
  } finally { await destination.close(); await source.close(); }
});

test('uma interrupção antes da emissão e uma expiração permitem nova verificação com todo o histórico',async t => {
  const owner = randomUUID();
  const s = await fixture(t,owner,false,true);
  try {
    let previous = await inventory(s.admin);
    let expiredFixture: Awaited<ReturnType<typeof seed>> | undefined;
    for (const [prefix,display,total,audits,replies] of [
      ['application_only','N000001',10,5,2],['revoked_initial','N000003',21,12,6],['complete','N000004',36,21,12],
      ['revoked_agent','N000005',49,29,17],
    ] as const) {
      if (prefix==='revoked_initial') await s.admin.query("SELECT nextval('career.application_display_sequence')");
      const runId = randomUUID(), approvalId = randomUUID(), key = randomUUID(), packageHash = 'd'.repeat(64);
      const cmd = {approvalId,runId,packageHash};
      const invoke = () => s.post(cmd,key,path);
      const f = await seed(s,runId,invoke,token=>s.post(cmd,key,path,token),prefix);
      if (prefix==='application_only') {
        await s.admin.query('BEGIN');
        try {
          await s.admin.query('SELECT pg_advisory_xact_lock(1128354386,1)');
          await s.admin.query('REVOKE career_fixture_executor FROM postgres');
          await assert.rejects(s.admin.query('SELECT career_maintenance.baseline($1,$2)',[runId,prefix]),{code:'P0412'});
        } finally { await s.admin.query('ROLLBACK'); }
      }
      if (prefix==='revoked_initial') {
        expiredFixture=f;
        await s.admin.query('BEGIN');
        try {
          await s.admin.query('SELECT pg_advisory_xact_lock(1128354386,1)');
          await assert.rejects(s.admin.query("SELECT career_maintenance.baseline($1,'application_only')",[runId]),{code:'P0412'});
        } finally { await s.admin.query('ROLLBACK'); }
        await s.admin.query('BEGIN');
        try {
          await s.admin.query('SELECT pg_advisory_xact_lock(1128354386,1)');
          await s.admin.query("UPDATE career.audit_log SET source='alterada' WHERE source='maintenance'");
          await assert.rejects(s.admin.query('SELECT career_maintenance.baseline($1,$2)',[runId,prefix]),{code:'P0412'});
        } finally { await s.admin.query('ROLLBACK'); }
      }
      await s.admin.query('BEGIN');
      try {
        await s.admin.query('SELECT pg_advisory_xact_lock(1128354386,1)');
        await s.admin.query(`INSERT INTO career_maintenance.approvals(id,owner_id,run_id,package_hash,baseline_hash,
          expires_at,command_key,application_id,opportunity_id,credential_id,application_client_id,application_mapping_id,
          credential_mapping_id,attempted_keys,prefix,display_id) VALUES($1,$2,$3,$4,career_maintenance.baseline($3,$13),
          clock_timestamp()+interval '10 minutes',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [approvalId,owner,runId,packageHash,key,f.application,f.opportunity,f.credential,f.client,f.appMapping,f.credMapping,f.keys,prefix,display]);
        await s.admin.query('COMMIT');
      } catch (error) { await s.admin.query('ROLLBACK'); throw error; }
      const result = await invoke();
      assert.equal(result.status,200,JSON.stringify(result.json.error));
      assert.equal(result.json.credentialId,f.credential ?? undefined);
      assert.equal(result.json.credentialMappingId,f.credMapping ?? undefined);
      assert.deepEqual((await invoke()).json,result.json);
      const current = await inventory(s.admin);
      assert.equal(Object.values(current).flat().length,total);
      assert.equal(current.audit_log!.length,audits);
      assert.equal(current.mutation_keys!.length,replies);
      for (const [table,hashes] of Object.entries(previous)) for (const hash of hashes) assert.ok(current[table]!.includes(hash));
      previous=current;
    }
    assert.ok(expiredFixture);
    assert.equal((await s.admin.query("SELECT nextval('career.application_display_sequence') AS gap")).rows[0].gap,'6');
    const actor = await s.ownerAuth(human);
    const exported = await createExportService(s.db).json(actor);
    assert.equal(exported.entities.filter(row=>row.table==='audit_log').length,29);
    const destination = await fixture(t,owner,true);
    try {
      assert.equal(exported.manifest.continuity?.displayHighWater,'6');
      assert.equal(exported.manifest.continuity.retiredClients.length,7);
      assert.equal(exported.manifest.continuity.retiredKeys.length,19);
      const {continuity, ...legacyManifest} = exported.manifest;
      const options = {actor,ownerId:owner,database:destination.restoreConfig};
      const legacy = {manifest:legacyManifest,entities:exported.entities};
      const changed = {...exported,manifest:{...exported.manifest,continuity:{...continuity,displayHighWater:'5'}}};
      await assert.rejects(restorePrivate({...options,snapshot:changed,mode:'apply'}));
      assert.equal((await restorePrivate({...options,snapshot:legacy,mode:'preview'})).state,'preview-continuity-required');
      await assert.rejects(restorePrivate({...options,snapshot:legacy,mode:'apply'}),/continuidade da origem/);
      assert.equal((await destination.admin.query('SELECT 1 FROM career.restore_runs')).rowCount,0);
      const maintenanceClient = new pg.Client(destination.restoreConfig);
      await maintenanceClient.connect();
      try {
        await assert.rejects(maintenanceClient.query("INSERT INTO career_maintenance.retired_identities VALUES($1,'client',$2)",
          [owner,continuity.retiredClients[0]]),{code:'42501'});
      } finally { await maintenanceClient.end(); }
      const restored = await restorePrivate({...options,snapshot:exported,mode:'apply'});
      const copy = await createExportService(destination.db).json(actor);
      assert.deepEqual(copy.entities.filter(row=>!(row.table==='audit_log' && row.data.id===restored.runId)),exported.entities);
      assert.equal(copy.entities.filter(row=>row.table==='audit_log').length,30);
      assert.equal((await destination.admin.query('SELECT 1 FROM career_maintenance.approvals')).rowCount,0);
      assert.equal((await destination.admin.query('SELECT 1 FROM career_maintenance.outcomes')).rowCount,0);
      assert.deepEqual(copy.manifest.continuity,continuity);
      const fresh = await destination.post({...expiredFixture.save,clientId:randomUUID()},randomUUID());
      assert.equal(fresh.status,201);
      assert.equal(fresh.json.application.displayId,'N000007');
      for (const refusal of [
        await destination.post(expiredFixture.save,randomUUID()),
        await destination.post({...expiredFixture.save,clientId:randomUUID()},expiredFixture.keys[2]!),
      ]) {
        assert.equal(refusal.status,409);
        assert.equal(refusal.json.error.code,'IDEMPOTENCY_CONFLICT');
      }
    } finally { await destination.close(); }
  } finally { await s.close(); }
});
