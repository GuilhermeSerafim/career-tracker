import { describe, expect, it } from 'vitest';
import { readServerConfig } from '../../server/config';

const env = {
  NODE_ENV: 'test', OWNER_USER_ID: '00000000-0000-4000-8000-000000000001',
  SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
  DATABASE_URL: 'postgresql://career_api:synthetic-password@127.0.0.1:55432/career_tracker_test',
  DATABASE_TLS: 'disable-local',
};
describe('configuração privada', () => {
  it('permite TLS desativado somente em teste local explícito e limita o pool', () => {
    expect(readServerConfig(env).database).toMatchObject({ user: 'career_api', ssl: false, max: 3, host: '127.0.0.1' });
  });
  it('exige validação TLS e modo transaction para produção', () => {
    const config = readServerConfig({ ...env, NODE_ENV: 'production', SUPABASE_URL: 'https://synthetic.supabase.co', DATABASE_URL: 'postgresql://career_api.synthetic:synthetic-password@pooler.example.test:6543/postgres', DATABASE_TLS: 'verify-full', DATABASE_POOL_MODE: 'transaction' });
    expect(config.database.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(config.database.connectionString).toBeUndefined();
  });
  it.each([
    { OWNER_USER_ID: 'not-uuid' }, { SUPABASE_PUBLISHABLE_KEY: '' },
    { DATABASE_URL: env.DATABASE_URL.replace('career_api:', 'postgres:') },
    { DATABASE_URL: `${env.DATABASE_URL}?sslmode=disable` },
    { DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'remote.example.test') },
    { NODE_ENV: 'production' }, { DATABASE_TLS: 'disable' },
    { DATABASE_POOL_MAX: '25' }, { SUPABASE_URL: 'http://remote.example.test' },
    { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_' + 'x'.repeat(24) },
  ])('rejeita configuração insegura sem revelar valores: %o', (overrides) => {
    expect(() => readServerConfig({ ...env, ...overrides })).toThrow('Configuração');
    try { readServerConfig({ ...env, ...overrides }); }
    catch (error) { expect(String(error)).not.toContain('synthetic-password'); }
  });
});
