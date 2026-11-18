import { expect, it } from 'vitest';
import { localDatabaseConfig } from '../../scripts/local-db';
import { readMaintenanceConfig } from '../../scripts/restore-private';
const url = 'postgresql://tester:placeholder@127.0.0.1:55434/career_tracker_restore_test';
it('aceita somente a identidade exata do destino sintético separado', () => {
    expect(localDatabaseConfig(url)).toMatchObject({ host: '127.0.0.1', port: 55434, database: 'career_tracker_restore_test' });
    for (const invalid of [url.replace('55434', '55433'), url.replace('127.0.0.1', 'localhost'), url.replace('127.0.0.1', 'db.example.test'), url.replace('restore_test', 'production')])
        expect(() => localDatabaseConfig(invalid)).toThrow();
});
it('lê somente a credencial privada de manutenção com TLS e principal próprios', () => {
    const env = { NODE_ENV: 'test', PRIVATE_RESTORE_DATABASE_URL: url.replace('tester:', 'career_restore:'), PRIVATE_RESTORE_DATABASE_TLS: 'disable-local' };
    expect(readMaintenanceConfig(env)).toMatchObject({ user: 'career_restore', ssl: false, host: '127.0.0.1' });
    expect(() => readMaintenanceConfig({ ...env, PRIVATE_RESTORE_DATABASE_URL: env.PRIVATE_RESTORE_DATABASE_URL.replace('career_restore:', 'career_api:') })).toThrow();
    expect(() => readMaintenanceConfig({ ...env, NODE_ENV: 'production' })).toThrow();
    expect(() => readMaintenanceConfig({ ...env, PRIVATE_RESTORE_DATABASE_URL: env.PRIVATE_RESTORE_DATABASE_URL + '?sslmode=disable' })).toThrow();
    expect(() => readMaintenanceConfig({ DATABASE_URL: env.PRIVATE_RESTORE_DATABASE_URL })).toThrow();
});
