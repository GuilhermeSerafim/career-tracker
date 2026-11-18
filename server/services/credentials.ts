import { commandSchema } from '../../shared/commands.js';
import { credentialMetadataSchema, credentialResultSchema, type CredentialMetadata } from '../../shared/agent-credentials.js';
import { canonicalRequestHash, createMutation } from '../mutation.js';
import type { createDatabase, Transaction } from '../database';
import { SafeError } from '../errors.js';

export const credentialProjection = `id,version,label,prefix,scopes,expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt"`;
export function credentialMetadata(row: Record<string, unknown>): CredentialMetadata {
  return credentialMetadataSchema.parse({ ...row, ...Object.fromEntries(['expiresAt','revokedAt','createdAt'].map(key => [key, row[key] instanceof Date ? row[key].toISOString() : row[key]])) });
}
async function read(tx: Transaction, owner: string, id: string) {
  const row = (await tx.query(`SELECT ${credentialProjection} FROM career.agent_credentials WHERE owner_id=$1 AND id=$2`, [owner, id])).rows[0];
  if (!row) throw new SafeError('NOT_FOUND'); return credentialMetadata(row);
}
export function createCredentialService(database: ReturnType<typeof createDatabase>) {
  return createMutation(database, {
    operation: 'credential_command', commandSchema, responseSchema: credentialResultSchema,
    async execute(context, command) {
      if (context.actorKind !== 'owner') throw new SafeError('FORBIDDEN');
      if (command.operation === 'create_agent_credential') {
        // Serialize this creation identity independently of retry-key namespaces.
        await context.transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`credential:${context.ownerId}:${command.clientId}`]);
        const hash = canonicalRequestHash(command);
        const prior = (await context.transaction.query<{ payload_hash: string; result_credential_id: string }>("SELECT payload_hash,result_credential_id FROM career.creation_requests WHERE owner_id=$1 AND entity_type='agent_credential' AND client_id=$2", [context.ownerId, command.clientId])).rows[0];
        if (prior) {
          if (prior.payload_hash !== hash) throw new SafeError('IDEMPOTENCY_CONFLICT');
          return { status: 201, body: { credential: await read(context.transaction, context.ownerId, prior.result_credential_id) } };
        }
        if (command.expiresAt !== null && new Date(command.expiresAt).getTime() <= Date.now()) throw new SafeError('INVALID_INPUT');
        await context.transaction.query('INSERT INTO career.agent_credentials(id,owner_id,label,prefix,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [command.clientId, context.ownerId, command.label, command.prefix, command.tokenHash, command.scopes, command.expiresAt]);
        await context.transaction.query("INSERT INTO career.creation_requests(owner_id,entity_type,client_id,payload_hash,result_credential_id) VALUES($1,'agent_credential',$2,$3,$2)", [context.ownerId, command.clientId, hash]);
        return { status: 201, body: { credential: await read(context.transaction, context.ownerId, command.clientId) } };
      }
      if (command.operation !== 'revoke_agent_credential') throw new SafeError('INVALID_INPUT');
      await context.lockAggregates([{ table: 'agent_credentials', id: command.credential.id }]);
      const row = await read(context.transaction, context.ownerId, command.credential.id);
      if (row.version !== command.credential.expectedVersion) throw new SafeError('CONFLICT', { details: { currentVersion: row.version, changedFields: ['revoked_at'] } });
      if (!row.revokedAt) await context.transaction.query('UPDATE career.agent_credentials SET revoked_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2', [context.ownerId, row.id]);
      return { status: 200, body: { credential: await read(context.transaction, context.ownerId, row.id) } };
    },
  });
}
