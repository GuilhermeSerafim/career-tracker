import { z } from 'zod';
import type { HistoricalPackageView as HistoricalPackage } from '../../../shared/historical-package';
import { transferEntitySchema } from '../../../shared/transfer';
import type { AppRuntime } from '../../app/runtime';
import { ApiError } from '../../lib/api';

const receipt = z.object({ applicationId: z.uuid(), version: z.number().int().positive(), result: z.literal('imported') });
export const previewSchema = z.strictObject({
  digest: z.string().regex(/^[0-9a-f]{64}$/), operationId: z.uuid(), rows: z.number().int().positive(),
  sources: z.number().int().positive(), members: z.literal(30), warnings: z.array(z.string()),
  resume: z.strictObject({ runId: z.uuid(), reviewed: z.boolean(), completed: z.boolean() }).nullable(),
});
export type PackagePreview = z.infer<typeof previewSchema>;
type Receipt = z.infer<typeof receipt>;

export async function previewHistorical(runtime: AppRuntime, file: File) {
  if (!file.size || file.size > 2_000_000) throw new ApiError(413);
  const period = runtime.getAccessPeriod();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16_384) binary += String.fromCharCode(...bytes.subarray(i, i + 16_384));
  const bytesBase64 = btoa(binary);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (period !== runtime.getAccessPeriod()) throw new ApiError(0);
  const result = previewSchema.parse(await runtime.transfers.previewHistorical(bytesBase64));
  const data: HistoricalPackage = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  if (period !== runtime.getAccessPeriod() || runtime.auth.getSnapshot().ownerId !== data.ownerId ||
      result.digest !== digest || result.operationId !== data.operationId || result.rows !== data.applications.length) throw new ApiError(409);
  return { data, bytesBase64, result, period };
}
type Prepared = Awaited<ReturnType<typeof previewHistorical>>;

export function resolveHistoricalReview(data: HistoricalPackage, runId: string, receipts: Map<string, Receipt>, exported: unknown) {
  const snapshot = z.object({ manifest: z.object({ sourceOwnerId: z.uuid() }), entities: z.array(transferEntitySchema) }).parse(exported);
  if (snapshot.manifest.sourceOwnerId !== data.ownerId) throw new ApiError(409);
  const entities = snapshot.entities;
  const run = entities.find(row => row.table === 'import_runs' && row.data.id === runId);
  const csv = entities.find(row => row.table === 'source_files' && row.data.importRunId === runId && /\.csv$/i.test(row.data.fileName));
  if (run?.table !== 'import_runs' || run.data.sourceSetHash !== data.sourceSetHash || csv?.table !== 'source_files' ||
      csv.data.fileHash !== data.prepare.manifest.parsed.sourceHash) throw new ApiError(409);
  const importRows = entities.filter(row => row.table === 'import_rows').map(row => row.data).filter(row => row.sourceFileId === csv.data.id);
  const apps = entities.filter(row => row.table === 'applications').map(row => row.data);
  const requests = entities.filter(row => row.table === 'creation_requests').map(row => row.data);
  const events = entities.filter(row => row.table === 'events').map(row => row.data);
  const evidence = entities.filter(row => row.table === 'evidence').map(row => row.data);
  const populations = new Set(data.review.members.map(m => m.legacyId));
  const ids = new Map<string,string>();
  const externalResultApplicationIds: string[] = [], externalResultEventIds: string[] = [];
  for (const unit of data.applications) {
    const saved = receipts.get(unit.legacyId);
    const app = apps.find(row => row.legacyId === unit.legacyId);
    const imported = importRows.find(row => row.legacyId === unit.legacyId);
    const original = data.prepare.manifest.parsed.rows.find(row => row.legacyId === unit.legacyId);
    if (!saved || !app || !imported || !original || saved.applicationId !== app.id || saved.version !== app.version ||
        imported.targetApplicationId !== app.id || imported.appliedTargetVersion !== saved.version ||
        imported.originalText !== original.raw || imported.rowHash !== original.rawRowHash) throw new ApiError(409);
    for (const event of unit.historicalEvents ?? []) {
      const request = requests.find(row => row.entityType === 'event' && row.clientId === event.clientId);
      const actual = events.find(row => row.id === request?.resultEventId);
      const proof = evidence.find(row => row.id === actual?.evidenceId);
      if (!actual || actual.applicationId !== app.id || !proof || proof.kind !== 'texto_legado' || proof.originalText !== original.raw ||
          actual.kind !== event.kind || actual.state !== event.state || actual.sourceText !== event.sourceText || actual.resultText !== event.resultText ||
          actual.scoreValue !== event.scoreValue || actual.scoreUnit !== (event.scoreUnit?.trim() ?? null) || actual.supersedesEventId !== null ||
          Object.entries(event.occurredDate).some(([key, value]) => Reflect.get(actual.occurredDate, key) !== value)) throw new ApiError(409);
      ids.set(event.clientId, actual.id);
      if (!populations.has(unit.legacyId)) {
        if (!externalResultApplicationIds.includes(app.id)) externalResultApplicationIds.push(app.id);
        externalResultEventIds.push(actual.id);
      }
    }
  }
  const members = data.review.members.map(m => {
    const app = apps.find(a => a.legacyId === m.legacyId);
    if (!app || app.cycleOrder !== m.capturedOrder) throw new ApiError(409);
    return { ...m, expectedVersion: app.version };
  });
  const eventIds = data.review.snapshot.eventIds.map(clientId => {
    const id = ids.get(clientId);
    if (!id || externalResultEventIds.includes(id)) throw new ApiError(409);
    return id;
  });
  return { ...data.review, runId, members, snapshot: { ...data.review.snapshot, asOf: data.review.closedAt ?? data.capturedAt,
    populationIds: members.map(m => receipts.get(m.legacyId)!.applicationId), eventIds, externalResultApplicationIds, externalResultEventIds } };
}

export async function applyHistorical(runtime: AppRuntime, prepared: Prepared, progress: (message: string) => void, active: () => boolean) {
  const { data, result, period, bytesBase64 } = prepared;
  const current = () => {
    const auth = runtime.auth.getSnapshot();
    if (!active() || runtime.getAccessPeriod() !== period || auth.status !== 'authenticated' || auth.ownerId !== data.ownerId) throw new ApiError(0);
  };
  const send = (unit: 'prepare' | 'application' | 'review' | 'complete', body: Record<string,unknown>, suffix: string = unit) => {
    current();
    return runtime.transfers.applyHistorical({ unit, data: body }, 'history:' + data.operationId + ':' + suffix);
  };
  current();
  if (result.resume?.completed) {
    if (!result.resume.reviewed) throw new ApiError(409);
    return;
  }
  progress('Preparando fontes…');
  const { runId } = z.object({ runId: z.uuid() }).parse(await send('prepare', { format: 'historical_package', bytesBase64 }, 'prepare-v2'));
  if (!result.resume?.reviewed) {
    const receipts = new Map<string, Receipt>();
    for (const [index, unit] of data.applications.entries()) {
      progress('Candidatura ' + (index + 1) + ' de ' + result.rows);
      receipts.set(unit.legacyId, receipt.parse(await send('application', { ...unit, runId }, 'app:' + index)));
    }
    current(); progress('Conferindo os vínculos da revisão…');
    const snapshot = await runtime.transfers.historicalSnapshot();
    const review = resolveHistoricalReview(data, runId, receipts, snapshot);
    z.object({ reviewId: z.uuid(), batchId: z.uuid() }).parse(await send('review', review));
  }
  progress('Concluindo importação…');
  const done = await send('complete', { ...data.complete, runId });
  if (done.runId !== runId || done.rowCount !== result.rows || done.reviewRequired !== true) throw new ApiError(409);
  current();
}
