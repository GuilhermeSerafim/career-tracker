import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertAuthenticatedActor, assertLiveCredential } from './auth.js';
import type { AuthenticatedActor, CredentialLookup } from './auth';
import type { Permission } from './agent-policy';
import type { ServerConfig } from './config';
import { SafeError } from './errors.js';

// A etapa de restore deve usar este mesmo par em pg_advisory_xact_lock (exclusivo).
export const MAINTENANCE_LOCK = Object.freeze([1128354386, 1]);
export interface Transaction {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<pg.QueryResult<Row>>;
}
export interface RequestContext { readonly requestId: string }
const requestContexts = new WeakSet<RequestContext>();
export function createRequestContext(): RequestContext {
  const context = Object.freeze({ requestId: randomUUID() });
  requestContexts.add(context);
  return context;
}
export interface AuthenticatedTransaction extends Transaction { readonly requestId: string }

export function createDatabase(config: ServerConfig) {
  const pool = new pg.Pool(config.database);
  // Erros assíncronos do pool não podem imprimir URLs, credenciais ou payloads.
  pool.on('error', () => undefined);
  async function gated<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try { client = await pool.connect(); }
    catch { throw new SafeError('DATABASE_UNAVAILABLE'); }
    let broken = false;
    let active = true;
    let clientFailure: SafeError | undefined;
    let rejectClientFailure!: (error: SafeError) => void;
    const failed = new Promise<never>((_, reject) => { rejectClientFailure = reject; });
    const onClientError = () => {
      broken = true;
      clientFailure ??= new SafeError('DATABASE_UNAVAILABLE');
      rejectClientFailure(clientFailure);
    };
    // pg.Pool remove seu listener enquanto o cliente está emprestado.
    // A falha pode ocorrer entre queries, enquanto o callback aguarda outro trabalho.
    client.on('error', onClientError);
    const transaction: Transaction = {
      query: (sql, values) => {
        if (clientFailure) return Promise.reject(clientFailure);
        if (!active) return Promise.reject(new SafeError('NOT_CONFIGURED'));
        return client.query(sql, values);
      },
    };
    const run = async () => {
      await transaction.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await transaction.query('SELECT pg_advisory_xact_lock_shared($1,$2)', [...MAINTENANCE_LOCK]);
      const identity = await transaction.query<{ session_user: string; current_user: string }>('SELECT session_user,current_user');
      if (identity.rows[0]?.session_user !== 'career_api' || identity.rows[0]?.current_user !== 'career_api') throw new SafeError('NOT_CONFIGURED');
      const owner = await transaction.query<{ owner_id: string }>('SELECT owner_id FROM career.owner_config WHERE singleton');
      const state = await transaction.query<{ owner_id: string; state: string }>('SELECT owner_id,state FROM career.maintenance_state WHERE singleton');
      if (owner.rows.length !== 1 || owner.rows[0]?.owner_id !== config.ownerUserId || state.rows.length !== 1 || state.rows[0]?.owner_id !== config.ownerUserId) throw new SafeError('NOT_CONFIGURED');
      if (state.rows[0]?.state !== 'ready') throw new SafeError('MAINTENANCE');
      const result = await work(transaction);
      await transaction.query('COMMIT');
      return result;
    };
    try {
      return await Promise.race([run(), failed]);
    } catch (error) {
      active = false;
      if (!broken) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
      }
      const code = (error as { code?: string } | null)?.code;
      if (broken || code?.startsWith('08') || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '25P03', '57P01', '57P02', '57P03', '57014', '55P03'].includes(code ?? '')) throw new SafeError('DATABASE_UNAVAILABLE');
      // Ausência de migration/privilégios falha fechada sem retornar nomes internos.
      if (['42P01', '3F000', '42883'].includes(code ?? '')) throw new SafeError('NOT_CONFIGURED');
      throw error;
    } finally {
      active = false;
      // release reinstala primeiro o listener do pool, inclusive ao descartar o cliente.
      client.release(broken);
      client.removeListener('error', onClientError);
    }
  }
  return {
    // Chamar na inicialização. Também participa do gate; não consulta dados de negócio.
    assertReady: () => gated(async () => undefined),
    // Deliberately closed: no SQL, callback, filter, owner or business projection argument.
    lookupAgentCredential: (id: string): Promise<CredentialLookup | null> => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new SafeError('UNAUTHORIZED');
      return gated(async (client) => {
        await client.query("SELECT set_config('app.owner_id',$1,true)", [config.ownerUserId]);
        return (await client.query<CredentialLookup>('SELECT id,token_hash AS hash,scopes,expires_at,revoked_at FROM career.agent_credentials WHERE owner_id=$1 AND id=$2', [config.ownerUserId, id])).rows[0] ?? null;
      });
    },
    async transaction<T>(actor: AuthenticatedActor, work: (transaction: AuthenticatedTransaction) => Promise<T>, context = createRequestContext(), permission: Permission = 'owner'): Promise<T> {
      assertAuthenticatedActor(actor, config.ownerUserId);
      if (!requestContexts.has(context)) throw new SafeError('NOT_CONFIGURED');
      return gated(async (client) => {
        await client.query(`SELECT set_config('app.owner_id',$1,true),set_config('app.actor_kind',$2,true),
          set_config('app.actor_id',$3,true),set_config('app.source',$4,true),set_config('app.request_id',$5,true)`,
        [actor.ownerId, actor.actorKind, actor.actorId, actor.source, context.requestId]);
        if (actor.actorKind === 'agent') {
          // SHARE conflicts with revocation's UPDATE lock, even when no key changes.
          const row = (await client.query<CredentialLookup>('SELECT id,scopes,expires_at,revoked_at FROM career.agent_credentials WHERE owner_id=$1 AND id=$2 FOR SHARE', [config.ownerUserId, actor.actorId])).rows[0];
          assertLiveCredential(row);
          if (permission === 'owner' || !actor.scopes.includes(permission) || !row!.scopes.includes(permission)) throw new SafeError('FORBIDDEN');
        }
        let active = true;
        const transaction: AuthenticatedTransaction = {
          requestId: context.requestId,
          query: (sql, values) => {
            if (!active) throw new SafeError('NOT_CONFIGURED');
            return client.query(sql, values);
          },
        };
        try { return await work(transaction); }
        finally { active = false; }
      });
    },
    close: () => pool.end(),
  };
}
