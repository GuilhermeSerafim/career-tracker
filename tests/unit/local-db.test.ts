import { describe, expect, it, vi } from 'vitest';
import { LOCAL_TEST_DATABASE, LocalDatabaseError, localDatabaseConfig, runLocalDatabase } from '../../scripts/local-db';

const localUrl = 'postgresql://tester:local-placeholder@127.0.0.1:54322/career_tracker_test';

describe('proteção do banco local dedicado', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('aceita loopback explícito %s', (host) => {
    const config = localDatabaseConfig(localUrl.replace('127.0.0.1', host));
    expect(config.database).toBe(LOCAL_TEST_DATABASE);
    expect(config.host).toBe(host === '[::1]' ? '::1' : '127.0.0.1');
    expect(config.connectionString).toBeUndefined();
    expect(config.ssl).toBe(false);
  });

  it.each([
    undefined,
    'não é uma URL',
    localUrl.replace('postgresql:', 'https:'),
    localUrl.replace('127.0.0.1', 'db.example.com'),
    localUrl.replace('127.0.0.1', '127.0.0.1.example.com'),
    localUrl.replace('127.0.0.1', '0.0.0.0'),
    localUrl.replace('127.0.0.1', '192.168.1.2'),
    localUrl.replace('127.0.0.1', '2130706433'),
    localUrl.replace('127.0.0.1', '[::ffff:127.0.0.1]'),
    localUrl.replace('career_tracker_test', 'postgres'),
    localUrl.replace('career_tracker_test', 'career_tracker'),
    localUrl.replace('career_tracker_test', 'career_tracker_test/other'),
    `${localUrl}?host=db.example.com`,
    `${localUrl}?dbname=postgres`,
    `${localUrl}?options=-c%20search_path=public`,
    `${localUrl}#ignored`,
    localUrl.replace('tester:local-placeholder@', ''),
    localUrl.replace(':54322/', ':0/'),
    localUrl.replace('local-placeholder', '%XX'),
  ])('recusa destino inseguro ou ambíguo sem expor a URL', (value) => {
    expect(() => localDatabaseConfig(value)).toThrow(LocalDatabaseError);
    try { localDatabaseConfig(value); }
    catch (error) { expect(String(error)).not.toContain('local-placeholder'); }
  });

  it('não deixa variáveis PostgreSQL herdadas substituir o destino validado', () => {
    vi.stubEnv('PGHOST', 'db.example.com');
    vi.stubEnv('PGDATABASE', 'production');
    try {
      expect(localDatabaseConfig(localUrl)).toMatchObject({ host: '127.0.0.1', database: LOCAL_TEST_DATABASE, port: 54322 });
    } finally { vi.unstubAllEnvs(); }
  });

  it('recusa comandos diferentes de apply/check antes de conectar', async () => {
    await expect(runLocalDatabase('reset', localUrl)).rejects.toThrow('Uso:');
  });

  it('recusa URL remota antes de ler SQL ou conectar', async () => {
    await expect(runLocalDatabase('apply', localUrl.replace('127.0.0.1', 'db.example.com'))).rejects.toThrow('loopback');
  });
});
