import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { makeHistoricalContract, verifyHistoricalProgress, type HistoricalRunState } from './historical-integrity.js';
import { isExternalReviewResult } from '../../domain/cycles.js';
import { sha256 } from '../../domain/import.js';
import { TRANSFER_TABLES } from '../../domain/export.js';
import { instantSchema, sha256Schema, uuidSchema } from '../../shared/model.js';
import type { HistoricalPackageView } from '../../shared/historical-package.js';
import { reviewSnapshotSchema } from '../../shared/transfer.js';
import { SafeError } from '../errors.js';
import type { AuthenticatedTransaction } from '../database.js';
import { lockApplicationIdentity } from '../repositories/identities.js';
import { applicationSchema, importPrepareSchema, reviewSchema, verifyImportSources } from './imports.js';

export const historicalUpload = z.strictObject({ format: z.literal('historical_package'), bytesBase64: z.string().min(1).max(2_800_000) });
const application = z.strictObject(applicationSchema.shape).omit({ runId: true });
const member = z.strictObject({ legacyId: application.shape.legacyId, capturedOrder: z.number().int().positive().safe() });
const shell = reviewSnapshotSchema.pick({ schemaVersion: true, period: true, eventIds: true, metrics: true });
const template = z.strictObject({ ...reviewSchema.shape, members: z.array(member).length(30), snapshot: shell }).omit({ runId: true });
const envelope = z.strictObject({
  format: z.literal('career-tracker-historical-import/1'), operationId: uuidSchema, ownerId: uuidSchema,
  sourceSetHash: sha256Schema, capturedAt: instantSchema, prepare: importPrepareSchema,
  applications: z.array(application).min(30).max(150), review: template, complete: z.strictObject({ reviewRequired: z.literal(true) }),
});
export type HistoricalPackage = z.infer<typeof envelope>;
export function readHistoricalPackage(encoded: string, owner: string) {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 2_000_000) throw new SafeError('PAYLOAD_TOO_LARGE');
  if (bytes.toString('base64') !== encoded) throw new SafeError('INVALID_INPUT');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new SafeError('INVALID_INPUT'); }
  const parsed = envelope.safeParse(value);
  if (!parsed.success) throw new SafeError('INVALID_INPUT');
  const data = parsed.data satisfies HistoricalPackageView;
  if (data.ownerId !== owner) throw new SafeError('FORBIDDEN');
  const manifest = data.prepare.manifest;
  if (data.sourceSetHash !== manifest.sourceSetHash || data.prepare.cycle.expectedVersion !== null ||
      manifest.parsed.rows.length !== data.applications.length) throw new SafeError('INVALID_INPUT');
  const files = verifyImportSources(data.prepare);
  const markdown = files.find(file => file.name === data.review.markdownFile);
  if (!markdown || markdown.text.length > 50_000) throw new SafeError('INVALID_INPUT');
  const rows = new Map(manifest.parsed.rows.map(row => [row.legacyId, row]));
  const members = new Set(data.review.members.map(m => m.legacyId));
  const seen = new Set<string>(), eventClients = new Map<string,string>();
  for (const unit of data.applications) {
    if (!rows.has(unit.legacyId) || seen.has(unit.legacyId) || unit.expectedVersion !== null ||
        unit.expectedOpportunityVersion !== null || unit.decisions !== null || unit.affectedBatches.length) throw new SafeError('INVALID_INPUT');
    seen.add(unit.legacyId);
    for (const event of unit.historicalEvents) {
      if (eventClients.has(event.clientId) || (!members.has(unit.legacyId) && !isExternalReviewResult(event))) throw new SafeError('INVALID_INPUT');
      eventClients.set(event.clientId, unit.legacyId);
    }
  }
  if (members.size !== 30 || new Set(data.review.members.map(m => m.capturedOrder)).size !== 30 ||
      data.review.members.some(m => rows.get(m.legacyId)?.cycleOrder !== m.capturedOrder) ||
      (data.review.closedAt === null) !== (data.review.snapshotTimeMeaning === 'import_capture') ||
      new Set(data.review.snapshot.eventIds).size !== data.review.snapshot.eventIds.length ||
      data.review.snapshot.eventIds.some(id => !members.has(eventClients.get(id) ?? ''))) throw new SafeError('INVALID_INPUT');
  return { data, digest: sha256(bytes) };
}
export async function checkHistoricalDestination(tx: AuthenticatedTransaction, data: HistoricalPackage, digest: string) {
  await lockApplicationIdentity(tx, data.ownerId);
  const prior = await tx.query<{ id: string; digest: string; operation: string; source_set_hash: string; status: string; unit_state: HistoricalRunState }>(
    "SELECT id,unit_state,status,unit_state->>'packageDigest' AS digest,unit_state->>'operationId' AS operation,source_set_hash FROM career.import_runs WHERE owner_id=$1 AND (source_set_hash=$2 OR unit_state->>'operationId'=$3)",
    [data.ownerId, data.sourceSetHash, data.operationId]);
  if (prior.rows.length) {
    const row = prior.rows[0]!;
    if (prior.rows.length !== 1 || row.digest !== digest || row.operation !== data.operationId || row.source_set_hash !== data.sourceSetHash) throw new SafeError('IDEMPOTENCY_CONFLICT');
    const contract = makeHistoricalContract(data);
    if (row.unit_state.packageContract && !isDeepStrictEqual(row.unit_state.packageContract, contract)) throw new SafeError('CONFLICT');
    const progress = await verifyHistoricalProgress(tx, data.ownerId, row.id, row.status, row.unit_state, contract);
    return { ...progress, needsContract: !row.unit_state.packageContract };
  }
  const business = TRANSFER_TABLES.filter(table => table !== 'owner_settings' && table !== 'audit_log');
  const occupied = await tx.query(business.map(table => 'SELECT 1 FROM career.' + table + ' WHERE owner_id=$1').join(' UNION ALL ') + ' LIMIT 1', [data.ownerId]);
  if (occupied.rowCount) throw new SafeError('CONFLICT');
  return null;
}
