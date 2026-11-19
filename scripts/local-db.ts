import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

export const LOCAL_TEST_DATABASE = 'career_tracker_test';
const schemaDirectory = fileURLToPath(new URL('../supabase/schemas/', import.meta.url));

export class LocalDatabaseError extends Error {}

/** Contrato das etapas 3/4. Novas migrations atualizam explicitamente esta matriz. */
export async function validateSecurityCatalog(client: pg.Client): Promise<void> {
  const fail = () => { throw new LocalDatabaseError('O catálogo de segurança diverge do contrato de privilégios mínimos.'); };
  const fixtureInstalled = (await client.query("SELECT to_regclass('career_maintenance.approvals') IS NOT NULL AS installed")).rows[0].installed === true;
  const principals = ['career_api', 'career_restore', 'career_schema_owner', 'career_audit_writer'];
  if (fixtureInstalled) principals.push('career_fixture_executor');
  const roles = await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid) AS membership FROM pg_roles r WHERE rolname=ANY($1)`, [principals]);
  if (roles.rows.length !== principals.length || roles.rows.some((r) => r.rolsuper || r.rolcreatedb || r.rolcreaterole || r.rolreplication || r.rolbypassrls || r.membership || r.rolcanlogin !== ['career_api', 'career_restore'].includes(r.rolname))) fail();
  const tables = await client.query(`SELECT relname,relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) AS owner
    FROM pg_class WHERE relnamespace='career'::regnamespace AND relkind='r'`);
  if (!tables.rows.length || tables.rows.some((r) => !r.relrowsecurity || !r.relforcerowsecurity || r.owner !== 'career_schema_owner')) fail();
  const schema = await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='career'");
  if (schema.rows[0]?.owner !== 'career_schema_owner') fail();
  const auditInstalled = Boolean((await client.query("SELECT to_regprocedure('career.audit_business_change()') IS NOT NULL AS installed")).rows[0]?.installed);
  const objects = await client.query(`SELECT proname AS name,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE pronamespace='career'::regnamespace
    UNION ALL SELECT typname,pg_get_userbyid(typowner) FROM pg_type WHERE typnamespace='career'::regnamespace AND typtype='d'
    UNION ALL SELECT relname,pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace='career'::regnamespace AND relkind='S'`);
  if (objects.rows.some((r) => r.owner !== (r.name === 'audit_business_change' ? 'career_audit_writer' : 'career_schema_owner'))) fail();
  const access = await client.query(`SELECT rolname,has_schema_privilege(oid,'career','USAGE') AS usage,has_schema_privilege(oid,'career','CREATE') AS create
    FROM pg_roles WHERE rolname=ANY($1)`, [[...principals.filter((r) => r !== 'career_schema_owner'), 'anon', 'authenticated', 'service_role']]);
  if (access.rows.some((r) => r.create || r.usage !== ['career_api', 'career_restore', ...(fixtureInstalled ? ['career_fixture_executor'] : []), ...(auditInstalled ? ['career_audit_writer'] : [])].includes(r.rolname))) fail();
  const business = ['owner_settings', 'opportunities', 'applications', 'contacts', 'links', 'resume_refs', 'application_resumes', 'evidence', 'events', 'tasks', 'cycles', 'batches', 'batch_members', 'review_versions', 'import_runs', 'source_files', 'import_rows', 'audit_log', 'mutation_keys', 'agent_credentials', 'creation_requests', 'opportunity_identities'];
  const control = ['owner_config', 'maintenance_state', 'restore_runs', 'restore_row_ledger'];
  const expectedTables = [...business, ...control].sort();
  if (JSON.stringify(tables.rows.map((r) => r.relname).sort()) !== JSON.stringify(expectedTables)) fail();
  const grants = await client.query(`SELECT r.rolname,c.relname,p.privilege,
    has_table_privilege(r.oid,c.oid,p.privilege) AS allowed
    FROM pg_roles r CROSS JOIN pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p(privilege)
    WHERE r.rolname=ANY($1) AND c.relnamespace='career'::regnamespace AND c.relkind='r'`, [['career_api', 'career_restore', 'career_audit_writer', ...(fixtureInstalled ? ['career_fixture_executor'] : [])]]);
  for (const row of grants.rows) {
    let expected = false;
    if (row.rolname === 'career_api') {
      if (row.privilege === 'SELECT') expected = business.includes(row.relname) || ['owner_config', 'maintenance_state'].includes(row.relname);
      if (row.privilege === 'INSERT') expected = business.includes(row.relname) && row.relname !== 'audit_log';
      if (row.privilege === 'UPDATE') expected = business.includes(row.relname) && !['audit_log', 'review_versions', 'mutation_keys', 'creation_requests'].includes(row.relname);
    } else if (row.rolname === 'career_restore') {
      if (row.privilege === 'SELECT') expected = row.relname !== 'agent_credentials';
      if (row.privilege === 'INSERT') expected = (business.includes(row.relname) && !['agent_credentials', 'mutation_keys'].includes(row.relname)) || ['restore_runs', 'restore_row_ledger'].includes(row.relname);
    } else if (fixtureInstalled && row.rolname === 'career_fixture_executor') {
      const targets = ['opportunities','applications','agent_credentials','creation_requests'];
      expected = row.privilege === 'DELETE' && targets.includes(row.relname)
        || row.privilege === 'SELECT' && ['opportunities','applications','creation_requests','audit_log','mutation_keys'].includes(row.relname)
        || row.privilege === 'INSERT' && row.relname === 'mutation_keys';
    } else if (auditInstalled && row.rolname === 'career_audit_writer') {
      expected = row.privilege === 'INSERT' && row.relname === 'audit_log';
    }
    if (row.allowed !== expected) fail();
  }
  const columns = await client.query(`SELECT c.relname,a.attname,x.privilege_type,x.is_grantable,pg_get_userbyid(x.grantee) AS grantee
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
    WHERE c.relnamespace='career'::regnamespace AND a.attnum>0 AND NOT a.attisdropped`);
  const restoreColumns: Record<string, string[]> = {
    agent_credentials: ['id', 'owner_id', 'label', 'prefix', 'scopes', 'expires_at', 'revoked_at', 'created_at', 'updated_at', 'version'],
    restore_runs: ['state', 'restored_rows', 'verified_at', 'failure_text', 'version', 'updated_at'],
    restore_row_ledger: ['verified_at', 'version', 'updated_at'],
    maintenance_state: ['state', 'active_restore_run_id', 'manifest_hash', 'version', 'updated_at'],
  };
  const writerColumns: Record<string, string[]> = auditInstalled ? {
    owner_config: ['singleton', 'owner_id'],
    maintenance_state: ['singleton', 'owner_id', 'state', 'active_restore_run_id', 'manifest_hash'],
    restore_runs: ['id', 'owner_id', 'destination_owner_id', 'manifest_hash', 'state'],
  } : {};
  for (const row of columns.rows) {
    const allowed = row.grantee === 'career_fixture_executor' && fixtureInstalled ? { agent_credentials: ['id','owner_id','label','prefix','scopes','expires_at','revoked_at','version'] } : row.grantee === 'career_restore' ? restoreColumns : row.grantee === 'career_audit_writer' ? writerColumns : row.grantee === 'career_api' && auditInstalled ? { mutation_keys: ['http_status', 'safe_response'] } : {};
    const privilege = row.grantee === 'career_audit_writer' || row.relname === 'agent_credentials' ? 'SELECT' : 'UPDATE';
    if (row.is_grantable || !allowed[row.relname]?.includes(row.attname) || row.privilege_type !== privilege) fail();
  }
  if (columns.rows.length !== Object.values(restoreColumns).flat().length + Object.values(writerColumns).flat().length + (auditInstalled ? 2 : 0) + (fixtureInstalled ? 8 : 0)) fail();
  const functions = await client.query(`SELECT r.rolname,p.proname,p.prosecdef,
    has_function_privilege(r.oid,p.oid,'EXECUTE') AS allowed FROM pg_roles r CROSS JOIN pg_proc p
    WHERE r.rolname=ANY($1) AND p.pronamespace='career'::regnamespace`, [['career_api', 'career_restore', 'career_audit_writer']]);
  for (const row of functions.rows) {
    const common = ['valid_date_value', 'next_display_id', 'configured_owner'];
    const allowed = row.rolname === 'career_api' ? [...common, 'runtime_owner', 'runtime_ready'] : row.rolname === 'career_restore' ? [...common, 'restore_insert_allowed'] : ['audit_business_change'];
    if (row.prosecdef !== (row.proname === 'audit_business_change') || row.allowed !== allowed.includes(row.proname)) fail();
  }
  const sequences = await client.query(`SELECT r.rolname,c.relname,p.privilege,has_sequence_privilege(r.oid,c.oid,p.privilege) AS allowed
    FROM pg_roles r CROSS JOIN pg_class c CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p(privilege)
    WHERE r.rolname=ANY($1) AND c.relnamespace='career'::regnamespace AND c.relkind='S'`, [['career_api', 'career_restore', 'career_audit_writer']]);
  const transferInstalled = Boolean((await client.query("SELECT EXISTS(SELECT FROM pg_attribute WHERE attrelid='career.restore_runs'::regclass AND attname='destination_key' AND NOT attisdropped) AS installed")).rows[0]?.installed);
  if (sequences.rows.some((r) => r.allowed !== (r.relname === 'application_display_sequence' && (r.rolname === 'career_api' && (r.privilege === 'USAGE' || fixtureInstalled && r.privilege === 'SELECT') || r.rolname === 'career_restore' && (r.privilege === 'USAGE' || transferInstalled))))) fail();
  if (fixtureInstalled) {
    const privateAccess = await client.query(`SELECT r.rolname AS role, c.relname AS name, p.privilege,
      has_table_privilege(r.oid,c.oid,p.privilege) AS allowed FROM pg_roles r CROSS JOIN pg_class c
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(privilege)
      WHERE c.relnamespace='career_maintenance'::regnamespace AND c.relkind='r'
      AND r.rolname=ANY($1)`, [[...principals, 'anon','authenticated','service_role']]);
    for (const row of privateAccess.rows) {
      const permitted = row.name === 'retired_identities'
        ? row.privilege === 'SELECT' && ['career_api','career_restore','career_fixture_executor','career_schema_owner'].includes(row.role)
          || row.privilege === 'INSERT' && ['career_restore','career_fixture_executor'].includes(row.role)
        : row.role === 'career_fixture_executor' && (row.privilege === 'SELECT' || row.name === 'outcomes' && row.privilege === 'INSERT');
      if (row.allowed !== permitted) fail();
    }
    const callable = await client.query(`SELECT p.proname AS name, r.rolname AS role,
      has_function_privilege(r.oid,p.oid,'EXECUTE') AS allowed FROM pg_proc p CROSS JOIN pg_roles r
      WHERE p.pronamespace='career_maintenance'::regnamespace AND r.rolname=ANY($1)`,
      [[...principals, 'anon','authenticated','service_role']]);
    const permitted: Record<string,string[]> = {
      career_api: ['remove_fixture'], career_schema_owner: ['baseline','history','catalog_hash','executor_stamp'],
      career_fixture_executor: ['baseline','history','allowed_target','lock_approval','remove_fixture','refuse_retired_identity'],
    };
    if (callable.rows.some(r => r.allowed !== (permitted[r.role]?.includes(r.name) ?? false))) fail();
    const stamp = await client.query(`SELECT ('career_maintenance.executor_stamp='||career_maintenance.executor_stamp())=ANY(proconfig) AS bound
      FROM pg_proc WHERE oid='career_maintenance.baseline(uuid,text)'::regprocedure`);
    if (stamp.rows[0]?.bound !== true) fail();
  }
  const unexpectedAcl = await client.query(`SELECT 1 FROM (
      SELECT x.* FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.relnamespace='career'::regnamespace
      UNION ALL SELECT x.* FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x WHERE p.pronamespace='career'::regnamespace
      UNION ALL SELECT x.* FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) x WHERE n.nspname='career'
    ) grants WHERE grantee NOT IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1))
       OR (is_grantable AND grantee <> 'career_schema_owner'::regrole)`, [principals]);
  if (unexpectedAcl.rows.length) fail();
  const publicPolicies = await client.query("SELECT 1 FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace='career'::regnamespace) AND 0=ANY(polroles)");
  if (publicPolicies.rows.length) fail();
  const reviewsInstalled = (await client.query("SELECT EXISTS(SELECT FROM pg_attribute WHERE attrelid='career.cycles'::regclass AND attname='is_current' AND NOT attisdropped) AS installed")).rows[0]?.installed;
  if (reviewsInstalled) {
    const guard = (await client.query(`SELECT t.tgname,t.tgtype,t.tgenabled,p.prosecdef,p.proconfig
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='career.batch_members'::regclass
      AND p.oid='career.guard_membership_insert()'::regprocedure`)).rows;
    if (guard.length !== 1 || guard[0].tgname !== 'batch_members_insert_guard' || guard[0].tgtype !== 7
      || guard[0].tgenabled !== 'O' || guard[0].prosecdef
      || JSON.stringify(guard[0].proconfig) !== JSON.stringify(['search_path=pg_catalog, career, pg_temp'])) fail();
  }
  if (auditInstalled) {
    const auditFunction = (await client.query("SELECT proconfig FROM pg_proc WHERE oid='career.audit_business_change()'::regprocedure")).rows[0];
    const config: string[] = auditFunction?.proconfig ?? [];
    if (config.length !== 2 || !config.includes('search_path=pg_catalog, career, pg_temp') || !config.some((item) => item.startsWith('app.audit_admin=') && !principals.includes(item.slice('app.audit_admin='.length)))) fail();
    const triggers = await client.query(`SELECT c.relname,t.tgname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,p.proname
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE p.oid IN ('career.audit_business_change()'::regprocedure,'career.require_completed_mutation()'::regprocedure,'career.preserve_mutation_reply()'::regprocedure)`);
    const audited = business.filter((name) => !['audit_log', 'mutation_keys', 'creation_requests'].includes(name)).sort();
    const businessTriggers = triggers.rows.filter((row) => row.proname === 'audit_business_change');
    if (JSON.stringify(businessTriggers.map((row) => row.relname).sort()) !== JSON.stringify(audited)
      || businessTriggers.some((row) => row.tgtype !== 29 || row.tgenabled !== 'O' || row.tgname !== 'business_audit')) fail();
    const completion = triggers.rows.filter((row) => row.proname === 'require_completed_mutation');
    if (completion.length !== 1 || completion[0].relname !== 'mutation_keys' || completion[0].tgtype !== 21 || completion[0].tgenabled !== 'O' || !completion[0].tgdeferrable || !completion[0].tginitdeferred) fail();
    const immutable = triggers.rows.filter((row) => row.proname === 'preserve_mutation_reply');
    if (immutable.length !== 1 || immutable[0].relname !== 'mutation_keys' || immutable[0].tgtype !== 19 || immutable[0].tgenabled !== 'O') fail();
  }
}

export function localDatabaseConfig(value: string | undefined): pg.ClientConfig {
  if (!value) throw new LocalDatabaseError('Defina LOCAL_TEST_DATABASE_URL para o banco de teste dedicado.');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new LocalDatabaseError('A URL do banco local é inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new LocalDatabaseError('Somente URLs PostgreSQL são aceitas.');
  }
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new LocalDatabaseError('O banco de teste deve usar um host loopback explícito.');
  }
  if (url.search || url.hash) {
    throw new LocalDatabaseError('Parâmetros e fragmentos de URL não são permitidos.');
  }
  let database: string;
  let user: string;
  let password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch { throw new LocalDatabaseError('A codificação da URL do banco local é inválida.'); }
  const restoreTarget = database === 'career_tracker_restore_test' && url.hostname === '127.0.0.1' && url.port === '55434';
  if (database !== LOCAL_TEST_DATABASE && !restoreTarget) {
    throw new LocalDatabaseError(`Somente o banco dedicado ${LOCAL_TEST_DATABASE} é permitido.`);
  }
  if (!user) throw new LocalDatabaseError('Informe explicitamente o usuário PostgreSQL local.');
  const port = Number(url.port || '54322');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LocalDatabaseError('A porta do banco local é inválida.');
  }
  // Nunca repassar a connectionString: parâmetros de URL e PGHOST não podem alterar o destino.
  return {
    host: url.hostname === '[::1]' ? '::1' : '127.0.0.1',
    port,
    database,
    user,
    password,
    ssl: false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
    application_name: 'career-tracker-local-test',
  };
}

interface SchemaFile { name: string; sql: string; digest: string }
interface AppliedSchema { name: string; digest: string }

async function readSchemas(): Promise<SchemaFile[]> {
  let entries: Dirent[];
  try { entries = await readdir(schemaDirectory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  const names = entries.filter((entry) => entry.isFile() && /^\d+_[a-z0-9_]+\.sql$/.test(entry.name))
    .map((entry) => entry.name).sort();
  if (!names.length) {
    throw new LocalDatabaseError('Schema ainda não configurado: adicione SQL revisado em supabase/schemas antes de aplicar ou verificar.');
  }
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(resolve(schemaDirectory, name), 'utf8');
    return { name, sql, digest: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function runLocalDatabase(command: string | undefined, value: string | undefined): Promise<void> {
  if (command !== 'apply' && command !== 'check') {
    throw new LocalDatabaseError('Uso: npm run db:local:apply ou npm run db:local:check.');
  }
  const config = localDatabaseConfig(value);
  const schemas = await readSchemas();
  const client = new pg.Client(config);
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query(command === 'check' ? 'BEGIN READ ONLY' : 'BEGIN');
    transactionStarted = true;
    const identity = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (identity.rows[0]?.name !== config.database) {
      throw new LocalDatabaseError('O servidor não confirmou o banco de teste dedicado.');
    }
    if (command === 'apply') {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('career-tracker-local-schema'))");
      await client.query('CREATE SCHEMA IF NOT EXISTS career_tracker_local');
      await client.query('REVOKE ALL ON SCHEMA career_tracker_local FROM PUBLIC');
      await client.query('CREATE TABLE IF NOT EXISTS career_tracker_local.schema_files (name text PRIMARY KEY, digest text NOT NULL)');
    } else {
      const table = await client.query<{ name: string | null }>("SELECT to_regclass('career_tracker_local.schema_files')::text AS name");
      if (!table.rows[0]?.name) throw new LocalDatabaseError('Schema local ainda não aplicado.');
    }
    const applied = await client.query<AppliedSchema>('SELECT name, digest FROM career_tracker_local.schema_files ORDER BY name');
    for (const prior of applied.rows) {
      const source = schemas.find((schema) => schema.name === prior.name);
      if (!source || source.digest !== prior.digest) {
        throw new LocalDatabaseError('Um SQL já aplicado foi removido ou alterado. Preserve o histórico e adicione um novo arquivo revisado.');
      }
    }
    const pending = schemas.filter((schema) => !applied.rows.some((prior) => prior.name === schema.name));
    if (command === 'check' && pending.length) {
      throw new LocalDatabaseError('Há arquivos SQL pendentes no banco de teste local.');
    }
    if (command === 'apply') {
      for (const schema of pending) {
        await client.query(schema.sql);
        await client.query('INSERT INTO career_tracker_local.schema_files (name, digest) VALUES ($1, $2)', [schema.name, schema.digest]);
      }
    }
    if (schemas.some((schema) => schema.name === '002_security.sql')) await validateSecurityCatalog(client);
    await client.query('COMMIT');
    transactionStarted = false;
    console.log(command === 'apply' ? 'SQL revisado aplicado ao banco de teste local.' : 'Arquivos SQL e catálogo de segurança conferidos; execute os testes de integração para validar o comportamento.');
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
    throw error;
  }
  await client.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLocalDatabase(process.argv[2], process.env.LOCAL_TEST_DATABASE_URL).catch((error: unknown) => {
    console.error(error instanceof LocalDatabaseError ? error.message : 'Falha no banco de teste local. Confira o serviço e o SQL; nenhuma credencial foi exibida.');
    process.exitCode = 1;
  });
}
