import { isDeepStrictEqual } from 'node:util';
import { transferHash } from '../../domain/export.js';
import type { AuthenticatedTransaction } from '../database.js';
import { SafeError } from '../errors.js';
import { canonicalRequestHash } from '../mutation.js';
import type { HistoricalPackage } from './historical-package.js';

export function makeHistoricalContract(data: HistoricalPackage) {
  const members = new Set(data.review.members.map(member => member.legacyId));
  const external = data.applications.filter(unit => !members.has(unit.legacyId))
    .flatMap(unit => unit.historicalEvents.map(event => ({ clientId: event.clientId, legacyId: unit.legacyId })));
  return {
    applications: Object.fromEntries(data.applications.map(unit => [unit.legacyId, transferHash(unit)])),
    review: data.review, asOf: data.review.closedAt ?? data.capturedAt, external,
  };
}
export type HistoricalContract = ReturnType<typeof makeHistoricalContract>;
export interface StoredReview { requestHash: string; result: { reviewId: string; batchId: string } }
export interface HistoricalRunState {
  packageDigest?: string; operationId?: string; packageContract?: HistoricalContract;
  review?: StoredReview; completed?: { reviewRequired: boolean; runId: string; rowCount: number };
}
export function approvedContract(state: HistoricalRunState) {
  if (state.packageDigest && !state.packageContract) throw new SafeError('CONFLICT');
  return state.packageContract;
}
export function requireHistoricalApplication(contract: HistoricalContract, request: { runId: string; legacyId: string }) {
  const { runId, ...portable } = request;
  if (!runId || contract.applications[portable.legacyId] !== transferHash(portable)) throw new SafeError('IDEMPOTENCY_CONFLICT');
}
interface ApplicationReceipt {
  legacy_id: string; target_application_id: string; applied_target_version: number;
  request: { runId: string; legacyId: string }; result: { applicationId: string; version: number; result: string };
}
export async function loadHistoricalReceipts(tx: AuthenticatedTransaction, owner: string, runId: string, contract: HistoricalContract) {
  const { rows } = await tx.query<ApplicationReceipt>(`SELECT r.legacy_id,r.target_application_id,r.applied_target_version,r.resolution->'request' AS request,r.unit_result AS result
    FROM career.import_rows r JOIN career.source_files f ON f.id=r.source_file_id AND f.owner_id=r.owner_id
    WHERE f.owner_id=$1 AND f.import_run_id=$2`, [owner, runId]);
  const receipts = new Map<string, ApplicationReceipt>();
  for (const row of rows) {
    if (!row.request || row.request.runId !== runId || row.request.legacyId !== row.legacy_id || receipts.has(row.legacy_id) ||
        row.result?.result !== 'imported' || row.result.applicationId !== row.target_application_id || row.result.version !== row.applied_target_version) throw new SafeError('CONFLICT');
    requireHistoricalApplication(contract, row.request);
    receipts.set(row.legacy_id, row);
  }
  return receipts;
}
export async function historicalReviewHash(tx: AuthenticatedTransaction, owner: string, runId: string, contract: HistoricalContract, receipts: Map<string, ApplicationReceipt>) {
  if (receipts.size !== Object.keys(contract.applications).length) throw new SafeError('CONFLICT');
  const { review, external } = contract;
  const eventClients = [...review.snapshot.eventIds, ...external.map(event => event.clientId)];
  const events = await tx.query<{ client_id: string; id: string; application_id: string }>(`SELECT cr.client_id,e.id,e.application_id
    FROM career.creation_requests cr JOIN career.events e ON e.owner_id=cr.owner_id AND e.id=cr.result_event_id
    WHERE cr.owner_id=$1 AND cr.entity_type='event' AND cr.client_id=ANY($2::uuid[])`, [owner, eventClients]);
  const byClient = new Map(events.rows.map(row => [row.client_id, row]));
  if (byClient.size !== eventClients.length) throw new SafeError('CONFLICT');
  const members = review.members.map(member => ({ ...member, expectedVersion: receipts.get(member.legacyId)!.result.version }));
  const populationIds = members.map(member => receipts.get(member.legacyId)!.result.applicationId);
  const eventIds = review.snapshot.eventIds.map(clientId => {
    const event = byClient.get(clientId)!;
    if (!populationIds.includes(event.application_id)) throw new SafeError('CONFLICT');
    return event.id;
  });
  const externalResultEventIds = external.map(ref => {
    const event = byClient.get(ref.clientId)!;
    if (event.application_id !== receipts.get(ref.legacyId)!.result.applicationId) throw new SafeError('CONFLICT');
    return event.id;
  });
  const externalResultApplicationIds = [...new Set(external.map(ref => receipts.get(ref.legacyId)!.result.applicationId))];
  return canonicalRequestHash({ ...review, runId, members, snapshot: { ...review.snapshot, asOf: contract.asOf, populationIds,
    eventIds, externalResultApplicationIds, externalResultEventIds } });
}
export async function verifyHistoricalProgress(tx: AuthenticatedTransaction, owner: string, runId: string, status: string, state: HistoricalRunState, contract: HistoricalContract) {
  const receipts = await loadHistoricalReceipts(tx, owner, runId, contract);
  if (state.review) {
    const hash = await historicalReviewHash(tx, owner, runId, contract, receipts);
    const linked = await tx.query("SELECT 1 FROM career.review_versions WHERE owner_id=$1 AND id=$2 AND batch_id=$3 AND import_provenance->>'runId'=$4", [owner, state.review.result.reviewId, state.review.result.batchId, runId]);
    if (state.review.requestHash !== hash || !linked.rowCount) throw new SafeError('CONFLICT');
  }
  const completed = status === 'completed';
  if (completed !== !!state.completed || completed && (!state.review || !isDeepStrictEqual(state.completed, { runId, reviewRequired: true, rowCount: receipts.size }))) throw new SafeError('CONFLICT');
  return { runId, reviewed: !!state.review, completed };
}
