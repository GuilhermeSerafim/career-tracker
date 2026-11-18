import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_COMMAND_BYTES } from '../shared/commands.js';
import { assertAuthenticatedActor } from './auth.js';
import type { AuthenticatedActor } from './auth';
import { commandPermission } from './agent-policy.js';
import { createRequestContext } from './database.js';
import type { AuthenticatedTransaction, RequestContext, createDatabase } from './database';
import { SafeError, safeError } from './errors.js';
import { createSafeLogger } from './logger.js';
import type { RequestLog } from './logger';

export function canonicalRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  const pieces: string[] = []; const ancestors = new Set<object>();
  let bytes = 0; let nodes = 0;
  const append = (piece: string) => {
    bytes += Buffer.byteLength(piece);
    if (bytes > MAX_COMMAND_BYTES) throw new SafeError('PAYLOAD_TOO_LARGE');
    pieces.push(piece);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 50_000 || depth > 32) throw new SafeError('PAYLOAD_TOO_LARGE');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      append(JSON.stringify(item)); return;
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new SafeError('INVALID_INPUT');
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new SafeError('INVALID_INPUT');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new SafeError('INVALID_INPUT');
    ancestors.add(item);
    if (array) {
      const length = item.length;
      if (Object.keys(descriptors).length !== length + 1 || length > 50_000) throw new SafeError('INVALID_INPUT');
      append('[');
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) throw new SafeError('INVALID_INPUT');
        if (index) append(',');
        visit(descriptor.value, depth + 1);
      }
      append(']');
    } else {
      const keys = Object.keys(descriptors).sort();
      append('{');
      keys.forEach((key, index) => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable) throw new SafeError('INVALID_INPUT');
        if (index) append(',');
        append(JSON.stringify(key)); append(':'); visit(descriptor.value, depth + 1);
      });
      append('}');
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return pieces.join('');
}

const aggregateTables = ['applications', 'opportunities', 'contacts', 'tasks', 'events', 'cycles', 'batches', 'owner_settings', 'agent_credentials'] as const;
type AggregateTable = typeof aggregateTables[number];
export interface AggregateRef { table: AggregateTable; id: string }
export interface MutationContext {
  readonly actorKind: AuthenticatedActor['actorKind'];
  readonly ownerId: string;
  readonly requestId: string;
  readonly transaction: AuthenticatedTransaction;
  lockAggregates(references: readonly AggregateRef[]): Promise<void>;
  updateApplication(id: string, expectedVersion: number, changes: { notes: string | null }): Promise<{ id: string; version: number }>;
}
interface Definition<Input, Output> {
  operation: string;
  commandSchema: z.ZodType<Input>;
  responseSchema: z.ZodType<Output>;
  execute(context: MutationContext, command: Input): Promise<{ status: number; body: Output }>;
  logger?: (entry: RequestLog) => void;
  canonicalize?: (value: unknown) => string;
}

/** Registro estático no servidor; comandos HTTP nunca fornecem SQL ou callbacks. */
export function createMutation<Input, Output>(database: ReturnType<typeof createDatabase>, definition: Definition<Input, Output>) {
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(definition.operation)) throw new SafeError('NOT_CONFIGURED');
  const log = definition.logger ?? createSafeLogger();
  const envelope = z.strictObject({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/), command: definition.commandSchema });
  return async (actor: AuthenticatedActor, raw: unknown, suppliedContext?: RequestContext) => {
    const request = suppliedContext ?? createRequestContext(); const start = performance.now(); let status = 503;
    try {
      assertAuthenticatedActor(actor, actor.ownerId);
      const canonicalize = definition.canonicalize ?? canonicalJson;
      canonicalize(raw); // Limite e own keys antes de acessar o comando ou seus getters.
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) throw new SafeError('INVALID_INPUT');
      const hash = createHash('sha256').update(canonicalize({ operation: definition.operation, command: parsed.data.command })).digest('hex');
      const result = await database.transaction(actor, async (transaction) => {
        const namespace = [actor.ownerId, actor.actorKind, actor.actorId, definition.operation, parsed.data.idempotencyKey];
        const reservation = await transaction.query<{ id: string }>(`INSERT INTO career.mutation_keys
          (owner_id,actor_kind,actor_id,operation,idempotency_key,request_hash,http_status,safe_response)
          VALUES($1,$2,$3,$4,$5,$6,102,'{}')
          ON CONFLICT(owner_id,actor_kind,actor_id,operation,idempotency_key) DO NOTHING RETURNING id`, [...namespace, hash]);
        if (!reservation.rows[0]) {
          const previous = (await transaction.query<{ request_hash: string; http_status: number; safe_response: unknown }>(`SELECT request_hash,http_status,safe_response FROM career.mutation_keys
            WHERE owner_id=$1 AND actor_kind=$2 AND actor_id=$3 AND operation=$4 AND idempotency_key=$5`, namespace)).rows[0];
          if (!previous || previous.http_status < 200 || previous.http_status > 299) throw new SafeError('DATABASE_UNAVAILABLE');
          if (previous.request_hash !== hash) throw new SafeError('IDEMPOTENCY_CONFLICT');
          return { status: previous.http_status, body: definition.responseSchema.parse(previous.safe_response) };
        }
        const held = new Set<string>(); let lastLock = '';
        const context: MutationContext = {
          actorKind: actor.actorKind,
          ownerId: actor.ownerId, requestId: request.requestId, transaction,
          async lockAggregates(references) {
            if (references.length > 100) throw new SafeError('INVALID_INPUT');
            const ordered = references.map((ref) => {
              if (!aggregateTables.includes(ref.table) || !z.uuid().safeParse(ref.id).success) throw new SafeError('INVALID_INPUT');
              return { ...ref, id: ref.id.toLowerCase() };
            }).sort((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
            for (const ref of ordered) {
              const key = `${ref.table}:${ref.id}`;
              if (held.has(key)) continue;
              if (key < lastLock) throw new SafeError('NOT_CONFIGURED');
              const row = await transaction.query(`SELECT id FROM career.${ref.table} WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [actor.ownerId, ref.id]);
              if (!row.rowCount) throw new SafeError('NOT_FOUND');
              held.add(key); lastLock = key;
            }
          },
          async updateApplication(id, expectedVersion, changes) {
            await context.lockAggregates([{ table: 'applications', id }]);
            const changed = await transaction.query<{ id: string; version: number }>('UPDATE career.applications SET notes=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND version=$4 RETURNING id,version', [actor.ownerId, id, changes.notes, expectedVersion]);
            if (!changed.rows[0]) {
              const current = (await transaction.query<{ version: number }>('SELECT version FROM career.applications WHERE owner_id=$1 AND id=$2', [actor.ownerId, id])).rows[0];
              if (!current) throw new SafeError('NOT_FOUND');
              const fields = await transaction.query<{ field: string }>(`SELECT DISTINCT keys.field FROM career.audit_log a
                CROSS JOIN LATERAL jsonb_object_keys(a.diff) keys(field)
                WHERE a.owner_id=$1 AND a.entity_type='applications' AND a.entity_id=$2
                  AND (a.after_data->>'version')::integer > $3 AND keys.field NOT IN ('version','updated_at') ORDER BY keys.field`, [actor.ownerId, id, expectedVersion]);
              throw new SafeError('CONFLICT', { details: { currentVersion: current.version, changedFields: fields.rows.map((row) => row.field) } });
            }
            return changed.rows[0];
          },
        };
        const reply = await definition.execute(context, parsed.data.command);
        if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 299) throw new SafeError('NOT_CONFIGURED');
        const body = definition.responseSchema.parse(reply.body);
        const serialized = canonicalJson(body);
        const completed = await transaction.query(`UPDATE career.mutation_keys SET http_status=$3,safe_response=$4::jsonb
          WHERE owner_id=$1 AND id=$2 AND http_status=102 RETURNING id`, [actor.ownerId, reservation.rows[0].id, reply.status, serialized]);
        if (completed.rowCount !== 1) throw new SafeError('DATABASE_UNAVAILABLE');
        return { status: reply.status, body };
      }, request, commandPermission((parsed.data.command as { operation?: string }).operation ?? ''));
      status = result.status;
      return { ...result, requestId: request.requestId };
    } catch (error) {
      const safe = safeError(error, request.requestId); status = safe.status; throw safe;
    } finally {
      try { log({ requestId: request.requestId, operation: definition.operation, status, elapsedMs: performance.now() - start }); }
      catch { /* A confirmação do COMMIT independe do sink de logs. */ }
    }
  };
}
