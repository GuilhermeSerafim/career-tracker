import pg from 'pg';
import { LOCAL_TEST_DATABASE, localDatabaseConfig } from '../../scripts/local-db';

/** Somente o banco dedicado; cada caso usa transação revertida, sem limpar tabelas. */
export async function connectTestDatabase(): Promise<pg.Client> {
  const client = new pg.Client(localDatabaseConfig(process.env.LOCAL_TEST_DATABASE_URL));
  try {
    await client.connect();
    const { rows } = await client.query<{ name: string; version: string }>(
      'SELECT current_database() AS name, current_setting(\'server_version\') AS version',
    );
    if (rows[0]?.name !== LOCAL_TEST_DATABASE || !rows[0]?.version.startsWith('17.')) {
      throw new Error('Os testes exigem o banco dedicado com PostgreSQL 17.');
    }
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

export async function expectSqlState(client: pg.Client, sql: string, values: unknown[], state: string): Promise<void> {
  await client.query('SAVEPOINT constraint_case');
  let actual: string | undefined;
  try { await client.query(sql, values); }
  catch (error) { actual = (error as { code?: string }).code; }
  finally { await client.query('ROLLBACK TO SAVEPOINT constraint_case'); }
  if (actual !== state) throw new Error(`SQLSTATE esperado ${state}, recebido ${actual ?? 'sucesso'}.`);
}
