import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { localDatabaseConfig } from './local-db';
import { MAINTENANCE_LOCK } from '../server/database';

interface ProvisionOptions {
  adminUrl: string | undefined;
  ownerId: string | undefined;
  apiPassword: string | undefined;
  restorePassword: string | undefined;
  restoreReady?: boolean;
}
export class ProvisionError extends Error {}

// O protocolo SCRAM recebe senha ASCII explícita; o SQL contém somente o verificador.
// Não gerar senha nem registrar senha/verificador. O sal não é a credencial.
function verifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

export async function provisionOwner(options: ProvisionOptions): Promise<void> {
  const config = localDatabaseConfig(options.adminUrl);
  const parsedOwner = z.uuid().safeParse(options.ownerId);
  const passwords = [options.apiPassword, options.restorePassword];
  if (!parsedOwner.success || passwords.some((password) => !password || !/^[\x21-\x7e]{24,128}$/.test(password))) throw new ProvisionError('Informe proprietário UUID e duas senhas explícitas de 24 a 128 caracteres ASCII sem espaços.');
  if (options.apiPassword === options.restorePassword) throw new ProvisionError('Use credenciais distintas para execução e restauração.');
  const ownerId = parsedOwner.data.toLowerCase();
  const client = new pg.Client(config);
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [...MAINTENANCE_LOCK]);
    const owner = await client.query<{ owner_id: string }>('SELECT owner_id FROM career.owner_config');
    if (owner.rows.length > 1 || (owner.rows[0] && owner.rows[0].owner_id !== ownerId)) throw new ProvisionError('O proprietário existente é diferente; o provisionamento foi cancelado.');
    const roles = await client.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('career_api','career_restore')
      AND rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member=pg_roles.oid)`);
    if (roles.rows.length !== 2) throw new ProvisionError('Aplique e confira a migration de segurança antes do provisionamento.');
    await client.query('INSERT INTO career.owner_config(owner_id) VALUES($1) ON CONFLICT(singleton) DO NOTHING', [ownerId]);
    await client.query('INSERT INTO career.maintenance_state(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING', [ownerId]);
    await client.query(`SELECT set_config('app.owner_id',$1,true),set_config('app.actor_kind','owner',true),
      set_config('app.actor_id',$1,true),set_config('app.source','provisioning',true),set_config('app.request_id',$2,true)`, [ownerId, randomUUID()]);
    if (!options.restoreReady) await client.query('INSERT INTO career.owner_settings(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING', [ownerId]);
    // Identificadores fixos; escapeLiteral só recebe verificadores gerados localmente.
    await client.query(`ALTER ROLE career_api PASSWORD ${pg.escapeLiteral(verifier(options.apiPassword!))}`);
    await client.query(`ALTER ROLE career_restore PASSWORD ${pg.escapeLiteral(verifier(options.restorePassword!))}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof ProvisionError) throw error;
    throw new ProvisionError('Falha no provisionamento local; nenhuma credencial foi exibida.');
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const run = process.argv.length === 2 ? provisionOwner({
    adminUrl: process.env.LOCAL_RESTORE_READY === 'true' ? process.env.LOCAL_RESTORE_TEST_DATABASE_URL : process.env.LOCAL_TEST_DATABASE_URL, ownerId: process.env.OWNER_USER_ID,
    apiPassword: process.env.CAREER_API_PASSWORD, restorePassword: process.env.CAREER_RESTORE_PASSWORD,
    restoreReady: process.env.LOCAL_RESTORE_READY === 'true',
  }) : Promise.reject(new ProvisionError('Use somente variáveis de ambiente; argumentos não são aceitos.'));
  run.then(() => console.log('Proprietário local provisionado. Use o mesmo OWNER_USER_ID na configuração do servidor.'))
    .catch((error: unknown) => {
      console.error(error instanceof ProvisionError ? error.message : 'Configuração local inválida; nenhuma credencial foi exibida.');
      process.exitCode = 1;
    });
}
