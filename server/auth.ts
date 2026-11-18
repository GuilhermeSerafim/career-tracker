import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from './config';
import { SafeError } from './errors.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AgentScope } from '../shared/commands';

export interface AuthenticatedAgent {
  readonly ownerId: string;
  readonly actorId: string;
  readonly actorKind: 'agent';
  readonly source: 'agent';
  readonly scopes: readonly AgentScope[];
}
export type AuthenticatedActor = AuthenticatedOwner | AuthenticatedAgent;
export interface CredentialLookup {
  id: string; hash: string; scopes: string[]; expires_at: Date | string | null; revoked_at: Date | string | null;
}
const authenticatedAgents = new WeakSet<AuthenticatedAgent>();
export function assertAuthenticatedActor(actor: AuthenticatedActor, ownerId: string): void {
  if (actor?.actorKind === 'agent') {
    if (!authenticatedAgents.has(actor) || actor.ownerId !== ownerId) throw new SafeError('UNAUTHORIZED');
  } else assertAuthenticatedOwner(actor, ownerId);
}
export function assertLiveCredential(row: Pick<CredentialLookup, 'expires_at' | 'revoked_at'> | null | undefined): void {
  if (!row || row.revoked_at !== null || row.expires_at !== null && !(new Date(row.expires_at).getTime() > Date.now())) throw new SafeError('UNAUTHORIZED');
}
export async function authenticateAgent(header: string | undefined, config: Pick<ServerConfig, 'ownerUserId'>, database: { lookupAgentCredential(id: string): Promise<CredentialLookup | null> }): Promise<AuthenticatedAgent> {
  const match = /^Bearer ct_agent_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(header ?? '');
  if (!match) throw new SafeError('UNAUTHORIZED');
  const bytes = Buffer.from(match[2]!, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== match[2]) throw new SafeError('UNAUTHORIZED');
  const row = await database.lookupAgentCredential(match[1]!.toLowerCase());
  const digest = createHash('sha256').update(bytes).digest(); bytes.fill(0);
  // The absent-record path still performs the same fixed-length comparison.
  const validHash = !!row && /^[0-9a-f]{64}$/.test(row.hash);
  const equal = timingSafeEqual(digest, Buffer.from(validHash ? row!.hash : '0'.repeat(64), 'hex'));
  digest.fill(0);
  if (!equal || !validHash || row!.id !== match[1]!.toLowerCase()) throw new SafeError('UNAUTHORIZED');
  assertLiveCredential(row);
  const scopes = row!.scopes.filter((scope): scope is AgentScope => ['career:read', 'career:write', 'career:reviews', 'career:export'].includes(scope));
  const actor = Object.freeze({ ownerId: config.ownerUserId, actorId: row!.id, actorKind: 'agent', source: 'agent', scopes: Object.freeze(scopes) } as const);
  authenticatedAgents.add(actor); return actor;
}
export function createAuthenticator(config: ServerConfig, database: { lookupAgentCredential(id: string): Promise<CredentialLookup | null> }) {
  const human = createHumanAuthenticator(config);
  return (header: string | undefined): Promise<AuthenticatedActor> => /^Bearer ct_agent_/i.test(header ?? '') ? authenticateAgent(header, config, database) : human(header);
}

export interface AuthenticatedOwner {
  readonly ownerId: string;
  readonly actorId: string;
  readonly actorKind: 'owner';
  readonly source: 'web';
}
interface AuthVerifier {
  getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }>;
}
// Apenas objetos emitidos após validação remota podem abrir transações de negócio.
const authenticated = new WeakSet<AuthenticatedOwner>();
export function assertAuthenticatedOwner(actor: AuthenticatedOwner, ownerId: string): void {
  if (!authenticated.has(actor) || actor.ownerId !== ownerId) throw new SafeError('UNAUTHORIZED');
}

export function createHumanAuthenticator(config: ServerConfig) {
  const client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return (header: string | undefined) => authenticateBearer(header, config, client.auth);
}

export async function authenticateBearer(header: string | undefined, config: Pick<ServerConfig, 'ownerUserId'>, verifier: AuthVerifier): Promise<AuthenticatedOwner> {
  // Formato JWT apenas distingue a credencial humana. Nunca decodificamos claims para autorizar.
  if (!header || header.length > 16_384 || /\s$/.test(header)) throw new SafeError('UNAUTHORIZED');
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
  const token = match?.[1];
  if (!token) throw new SafeError('UNAUTHORIZED');
  let response: Awaited<ReturnType<AuthVerifier['getUser']>>;
  try { response = await verifier.getUser(token); }
  catch { throw new SafeError('AUTH_UNAVAILABLE'); }
  if (response.error) {
    const failure = response.error as { status?: number; name?: string };
    if (failure.status === 0 || (failure.status ?? 0) >= 500 || failure.status === 429 || failure.name === 'AuthRetryableFetchError') throw new SafeError('AUTH_UNAVAILABLE');
    throw new SafeError('UNAUTHORIZED');
  }
  if (!response.data.user?.id) throw new SafeError('UNAUTHORIZED');
  if (response.data.user.id.toLowerCase() !== config.ownerUserId) throw new SafeError('FORBIDDEN');
  const actor = Object.freeze({ ownerId: config.ownerUserId, actorId: config.ownerUserId, actorKind: 'owner', source: 'web' } as const);
  authenticated.add(actor);
  return actor;
}
