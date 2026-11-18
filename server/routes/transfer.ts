import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, validateSnapshot } from '../../domain/export.js';
import { compareLegacyRows, parseLegacyCsv, sha256 } from '../../domain/import.js';
import type { createDatabase, RequestContext } from '../database';
import type { AuthenticatedOwner } from '../auth';
import { SafeError } from '../errors.js';
import { createMutation } from '../mutation.js';
import { createImportService, importPrepareSchema } from '../services/imports.js';
import { loadImportBasis } from '../repositories/transfers.js';

/** Canonicalização de transferência separada do limite de comandos ordinários.
 * Só aceita JSON puro limitado; nenhum getter/callback vem da fronteira HTTP. */
function boundedTransferJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch {
    throw new SafeError('INVALID_INPUT');
  }
  if (Buffer.byteLength(serialized) > 4_000_000) throw new SafeError('PAYLOAD_TOO_LARGE');
  return serialized;
}
const applySchema = z.discriminatedUnion('unit', [
  z.strictObject({ unit: z.literal('prepare'), data: importPrepareSchema }),
  z.strictObject({ unit: z.literal('application'), data: z.unknown() }),
  z.strictObject({ unit: z.literal('review'), data: z.unknown() }),
  z.strictObject({ unit: z.literal('complete'), data: z.unknown() }),
]);
const uploadSchema = z.strictObject({ bytesBase64: z.string().max(4_000_000) });
const previewSchema = z.union([z.strictObject({ runId: z.uuid() }), uploadSchema]);
const restoreSchema = z.strictObject({ snapshot: z.unknown() });
export function createTransferRoute(database: ReturnType<typeof createDatabase>) {
  const imports = createImportService(database);
  const mutate = createMutation(database, {
    operation: 'import_unit',
    commandSchema: applySchema,
    responseSchema: z.record(z.string(), z.unknown()),
    canonicalize: boundedTransferJson,
    async execute(context, command) {
      // O ator de importação é configurado pelo serviço na mesma transação.
      // A reserva HTTP, unidade, domínio e auditoria só confirmam juntos.
      const actor = actors.get(context.requestId);
      if (!actor) throw new SafeError('NOT_CONFIGURED');
      const methods = {
        prepare: imports.prepare,
        application: imports.applyApplication,
        review: imports.applyReview,
        complete: imports.complete,
      };
      const body = await methods[command.unit](actor, command.data, context.transaction);
      return { status: 200, body: { ...body } };
    },
  });
  // Contextos gerados no servidor; entrada removida no finally, inclusive em falhas.
  const actors = new Map<string, AuthenticatedOwner>();
  return async (
    actor: AuthenticatedOwner,
    path: string,
    raw: unknown,
    key: string | undefined,
    context: RequestContext,
  ) => {
    if (path.endsWith('/imports/apply')) {
      actors.set(context.requestId, actor);
      try {
        return await mutate(actor, { idempotencyKey: key, command: raw }, context);
      } finally {
        actors.delete(context.requestId);
      }
    }
    if (path.endsWith('/imports/preview')) {
      const parsed = previewSchema.safeParse(raw);
      if (!parsed.success) throw new SafeError('INVALID_INPUT');
      if ('runId' in parsed.data) {
        const body = await database.transaction(
          actor,
          (tx) => imports.preview(actor, parsed.data, tx),
          context,
        );
        return { status: 200, body };
      }
      const encoded = parsed.data.bytesBase64;
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new SafeError('INVALID_INPUT');
      const parsedCsv = parseLegacyCsv(bytes);
      return database.transaction(
        actor,
        async (tx) => ({
          status: 200,
          body: {
            parsed: parsedCsv,
            diff: parsedCsv.blocked
              ? []
              : compareLegacyRows(parsedCsv.rows, await loadImportBasis(tx, actor.ownerId)),
            sourceHash: sha256(bytes),
            writes: false,
          },
        }),
        context,
      );
    }
    const parsed = restoreSchema.safeParse(raw);
    if (!parsed.success) throw new SafeError('INVALID_INPUT');
    let snapshot;
    try {
      snapshot = validateSnapshot(parsed.data.snapshot);
    } catch {
      throw new SafeError('INVALID_INPUT');
    }
    return database.transaction(
      actor,
      async () => ({
        status: 200,
        body: {
          validation: 'structural_only',
          structurallyValid: true,
          destinationReady: null,
          destinationSqlPreflight: 'not_performed',
          manifestHash: createHash('sha256').update(canonicalJson(snapshot.manifest)).digest('hex'),
          entityCount: snapshot.entities.length,
          nextAction: 'local_owner_maintenance_preview',
          message:
            'Estrutura e integridade conferidas. Use a prévia local com a sessão do proprietário e a credencial privada de manutenção para verificar o destino.',
        },
      }),
      context,
    );
  };
}
