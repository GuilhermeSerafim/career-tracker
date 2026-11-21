import { createHash } from 'node:crypto';
import { z } from 'zod';
import { csvConfirmationSchema, csvPreviewSchema, csvUploadSchema } from '../../shared/csv-upload.js';
import { planCsvUpload, readCsvUpload } from '../services/csv-upload.js';
import { canonicalJson, hasDisplayCapacity, restoreDisplayFloor, validateSnapshot } from '../../domain/export.js';
import { compareLegacyRows, parseLegacyCsv, sha256 } from '../../domain/import.js';
import type { createDatabase, RequestContext } from '../database';
import type { AuthenticatedOwner } from '../auth';
import { SafeError } from '../errors.js';
import { createMutation } from '../mutation.js';
import { createImportService, importPrepareSchema } from '../services/imports.js';
import { makeHistoricalContract } from '../services/historical-integrity.js';
import { historicalUpload, checkHistoricalDestination, readHistoricalPackage } from '../services/historical-package.js';
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
  z.strictObject({ unit: z.literal('csv'), data: csvConfirmationSchema }),
  z.strictObject({ unit: z.literal('prepare'), data: z.union([importPrepareSchema, historicalUpload]) }),
  z.strictObject({ unit: z.literal('application'), data: z.unknown() }),
  z.strictObject({ unit: z.literal('review'), data: z.unknown() }),
  z.strictObject({ unit: z.literal('complete'), data: z.unknown() }),
]);
const uploadSchema = z.strictObject({ bytesBase64: z.string().max(4_000_000) });
const previewSchema = z.union([historicalUpload, z.strictObject({ runId: z.uuid() }), csvUploadSchema.extend({ format: z.literal('csv_upload') }), uploadSchema]);
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
      if (command.unit === 'prepare' && 'format' in command.data) {
        const { data, digest } = readHistoricalPackage(command.data.bytesBase64, actor.ownerId);
        const tx = context.transaction;
        const previous = await checkHistoricalDestination(tx, data, digest);
        const prepared = await imports.prepare(actor, data.prepare, tx);
        if (!previous || previous.needsContract) await tx.query("UPDATE career.import_runs SET unit_state=unit_state || $3::jsonb WHERE owner_id=$1 AND id=$2", [actor.ownerId, prepared.runId, { packageDigest: digest, operationId: data.operationId, packageContract: makeHistoricalContract(data) }]);
        return { status: 200, body: prepared };
      }
      const methods = {
        csv: imports.applyCsv,
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
      if ('format' in parsed.data && parsed.data.format === 'historical_package') {
        if (actor.actorKind !== 'owner') throw new SafeError('FORBIDDEN');
        const { data, digest } = readHistoricalPackage(parsed.data.bytesBase64, actor.ownerId);
        const existing = await database.transaction(actor, tx => checkHistoricalDestination(tx, data, digest), context);
        return { status: 200, body: { digest, operationId: data.operationId, rows: data.applications.length, sources: data.prepare.sources.length, members: data.review.members.length, warnings: [...new Set(data.prepare.manifest.parsed.issues.map(issue => issue.code)), ...data.review.pendingIssues], resume: existing && { runId: existing.runId, reviewed: existing.reviewed, completed: existing.completed } } };
      }
      if ('runId' in parsed.data) {
        const body = await database.transaction(
          actor,
          (tx) => imports.preview(actor, parsed.data, tx),
          context,
        );
        return { status: 200, body };
      }
      if ('format' in parsed.data) {
        const { fileName } = parsed.data;
        const upload = readCsvUpload(parsed.data);
        const body = await database.transaction(
          actor, async (tx) => csvPreviewSchema.parse(await planCsvUpload(tx, actor.ownerId, fileName, upload.parsed)), context,
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
          message: !snapshot.manifest.continuity
            ? 'Estrutura e integridade conferidas. Esta exportação antiga exige nova captura da continuidade da origem antes da restauração.'
            : hasDisplayCapacity(restoreDisplayFloor(snapshot))
              ? 'Estrutura e integridade conferidas. Use a prévia local com a sessão do proprietário e a credencial privada de manutenção para verificar o destino.'
              : 'Estrutura e integridade conferidas. A sequência de candidaturas está esgotada e impede a ativação do destino.',
        },
      }),
      context,
    );
  };
}
