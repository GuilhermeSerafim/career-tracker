import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { authenticateAgent, type AuthenticatedOwner } from '../../server/auth';
import type { createDatabase } from '../../server/database';
import type { ServerConfig } from '../../server/config';
import { createCredentialService } from '../../server/services/credentials';

/** Actual scoped token verification replaces pre-Task20 copied-actor mocks. */
export async function authenticatedAgentFixture(database: ReturnType<typeof createDatabase>, config: ServerConfig, owner: AuthenticatedOwner) {
  const id = randomUUID(); const bytes = randomBytes(32); const secret = bytes.toString('base64url');
  const hash = createHash('sha256').update(bytes).digest('hex'); bytes.fill(0);
  await createCredentialService(database)(owner, { idempotencyKey: randomUUID(), command: { operation: 'create_agent_credential', clientId: id, label: 'Synthetic fixture', prefix: id.slice(0,8), tokenHash: hash, scopes: ['career:read','career:write','career:reviews','career:export'], expiresAt: null } });
  return authenticateAgent(`Bearer ct_agent_${id}.${secret}`, config, database);
}
