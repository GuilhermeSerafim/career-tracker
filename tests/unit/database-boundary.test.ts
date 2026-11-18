import { expect, it } from 'vitest';
import { createDatabase } from '../../server/database';
import { readServerConfig } from '../../server/config';
import { provisionOwner } from '../../scripts/provision-owner';

it('retorna erro seguro 503 quando o banco está indisponível', async () => {
  const config = readServerConfig({ NODE_ENV: 'test', OWNER_USER_ID: '00000000-0000-4000-8000-000000000001', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic', DATABASE_URL: 'postgresql://career_api:must-not-leak@127.0.0.1:1/career_tracker_test', DATABASE_TLS: 'disable-local' });
  const database = createDatabase(config);
  try {
    const result = database.assertReady();
    await expect(result).rejects.toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
    await expect(result).rejects.not.toThrow('must-not-leak');
  } finally { await database.close(); }
});

it('provisionamento rejeita destino remoto antes de conectar', async () => {
  await expect(provisionOwner({ adminUrl: 'postgresql://postgres:must-not-leak@remote.example.test/career_tracker_test', ownerId: '00000000-0000-4000-8000-000000000001', apiPassword: 'a'.repeat(32), restorePassword: 'b'.repeat(32) })).rejects.toThrow('loopback');
});

it.each([undefined, '', 'short', 'senha não ASCII '.repeat(4)])('provisionamento exige senhas explícitas seguras', async (apiPassword) => {
  await expect(provisionOwner({ adminUrl: 'postgresql://postgres:must-not-leak@127.0.0.1:1/career_tracker_test', ownerId: '00000000-0000-4000-8000-000000000001', apiPassword, restorePassword: 'b'.repeat(32) })).rejects.toThrow('senhas explícitas');
});
