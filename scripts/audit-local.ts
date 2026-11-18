import pg from 'pg';
import { localDatabaseConfig, validateSecurityCatalog } from './local-db';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function auditDedicatedDatabases() {
for (const [value, port, name] of [
  [process.env.LOCAL_TEST_DATABASE_URL, '55432', 'career_tracker_test'],
  [process.env.LOCAL_RESTORE_TEST_DATABASE_URL, '55434', 'career_tracker_restore_test'],
]) {
  const url = new URL(value ?? 'invalid:');
  if (url.hostname !== '127.0.0.1' || url.port !== port || url.pathname !== `/${name}`) throw Error('Destino local dedicado exigido.');
  const client = new pg.Client(localDatabaseConfig(value));
  try {
    await client.connect();
    const identity = (await client.query("SELECT current_database() AS name,current_setting('server_version') AS version")).rows[0];
    if (identity.name !== name || !identity.version.startsWith('17.')) throw Error('Identidade local incompatível.');
    const tables = (await client.query<{ name: string }>("SELECT relname AS name FROM pg_class WHERE relnamespace='career'::regnamespace AND relkind='r' ORDER BY relname")).rows;
    if (tables.length !== 26) throw Error('Catálogo incompleto.');
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table.name) || (await client.query(`SELECT 1 FROM career.${table.name} LIMIT 1`)).rowCount) throw Error('Dados retidos no banco sintético.');
    }
    await validateSecurityCatalog(client);
    if ((await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rowCount) throw Error('Outro consumidor conectado.');
    console.log(JSON.stringify({ database: name, version: identity.version, tables: tables.length, rows: 0, otherSessions: 0, security: 'PASS' }));
  } finally { await client.end(); }
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await auditDedicatedDatabases();
