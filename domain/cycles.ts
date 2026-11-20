import type { ApplicationMetricsRow } from '../shared/model';
import type { AnalyticsEvent, AnalyticsRow } from '../shared/analytics';
import { buildAnalytics, canonicalAttribution, eventHistory } from './metrics.js';
import { instantNanoseconds, toLocalDay } from './dates.js';

export const REVIEW_CALCULATION_VERSION = 'metrics-v1/review-v2';
export function isExternalReviewResult(event: Pick<AnalyticsEvent, 'kind'>): boolean {
  return !['nota', 'correcao', 'envio_confirmado', 'confirmacao_automatica'].includes(event.kind);
}
export function buildReviewSnapshot(rows: AnalyticsRow[], events: AnalyticsEvent[], populationIds: string[], asOf: string, countedIds = populationIds) {
  const population = new Set(populationIds);
  const capturedRows = rows.filter((row) => population.has(row.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const canonical = canonicalAttribution(rows);
  const memberRoots = new Set(populationIds.map(canonical));
  const { known, superseded } = eventHistory(events, canonical, asOf);
  const capturedEvents = known.filter((event) => memberRoots.has(canonical(event.applicationId)));
  const related = new Map<string, AnalyticsRow>();
  const traced = new Set<string>();
  const retainCanonicalPath = (originalId: string) => {
    let id: string | null = originalId;
    while (id !== null) {
      if (traced.has(id)) break;
      traced.add(id);
      const row: AnalyticsRow = byId.get(id)!;
      if (!population.has(id)) related.set(id, row);
      id = row.canonicalApplicationId;
    }
  };
  for (const id of populationIds) retainCanonicalPath(id);
  for (const event of capturedEvents) retainCanonicalPath(event.applicationId);
  const counted = new Set(countedIds);
  const eligible = capturedRows.filter((row) => counted.has(row.id) && allocationEligible(row));
  const eligibleIds = new Set(eligible.map((row) => row.id));
  const knownDays = capturedRows.flatMap((row) => { const day = toLocalDay(row.submittedDate); return day ? [day] : []; }).sort();
  const day = toLocalDay({ precision: 'instant', certainty: 'exact', value: asOf })!;
  // Somente os membros elegíveis compõem a coorte. As rotas canônicas preservam a proveniência.
  const interpretedRows = [...capturedRows, ...related.values()].map((row) => ({ ...row, countingEligible: eligibleIds.has(row.id) }));
  const analytics = buildAnalytics(interpretedRows, capturedEvents, { operation: 'metrics', period: { from: day, to: day }, population: 'confirmed', dimension: 'stack', asOf, dailyGoal: 0, submissionScope: 'all_dates' });
  const rejectionIds = [...new Set(capturedEvents.filter((event) => !superseded.has(event.id) && event.kind === 'rejeicao').map((event) => canonical(event.applicationId)).filter((id) => eligibleIds.has(id)))].sort();
  const externalCases = new Set<string>();
  for (const event of known) {
    const root = canonical(event.applicationId);
    if (!memberRoots.has(root) && byId.get(root)!.cycleRelation === 'before_reset' && isExternalReviewResult(event)) externalCases.add(root);
  }
  // A visibilidade MVCC deste conjunto não pode ser reconstruída só com a data de registro.
  const externalHistory = known.filter((event) => externalCases.has(canonical(event.applicationId)));
  for (const event of externalHistory) retainCanonicalPath(event.applicationId);
  const externalEvents = externalHistory.filter((event) => !superseded.has(event.id) && isExternalReviewResult(event));
  const externalIds = new Set(externalEvents.map((event) => canonical(event.applicationId)));
  return {
    schemaVersion: 1 as const, asOf,
    period: knownDays.length ? { from: knownDays[0]!, to: knownDays.at(-1)! } : null,
    populationIds: [...populationIds].sort(), eventIds: capturedEvents.map((event) => event.id).sort(),
    metrics: { ...analytics.conversions, rejection: { numerator: rejectionIds.length, denominator: eligible.length, ratio: eligible.length ? rejectionIds.length / eligible.length : null, applicationIds: rejectionIds } },
    calculationVersion: REVIEW_CALCULATION_VERSION, eligiblePopulationIds: [...eligibleIds].sort(),
    applications: capturedRows, relatedCanonicalApplications: [...related.values()].sort((a, b) => a.id.localeCompare(b.id)),
    events: capturedEvents, coverage: analytics.coverage, distributions: analytics.groups,
    completed: analytics.completed, firstReturn: analytics.firstReturn,
    externalEventHistoryIds: externalHistory.map((event) => event.id).sort(),
    externalResultApplicationIds: [...externalIds].sort(), externalResultEventIds: externalEvents.map((event) => event.id).sort(),
  };
}

type FrozenReview = Pick<ReturnType<typeof buildReviewSnapshot>, 'asOf' | 'populationIds' | 'eventIds' | 'externalResultEventIds' | 'applications' | 'relatedCanonicalApplications'>;
export function laterReviewEvents(rows: AnalyticsRow[], events: AnalyticsEvent[], asOf: string, snapshot: FrozenReview) {
  const canonical = canonicalAttribution(rows);
  const population = new Set(snapshot.populationIds.map(canonical));
  const captured = new Set([...snapshot.eventIds, ...snapshot.externalResultEventIds]);
  const frozenRows = [...snapshot.applications, ...snapshot.relatedCanonicalApplications];
  const frozenIds = new Set(frozenRows.map((row) => row.id));
  const frozenCanonical = canonicalAttribution(frozenRows);
  const frozenPopulation = new Set(snapshot.populationIds.map(frozenCanonical));
  const cutoff = instantNanoseconds(snapshot.asOf);
  const { known, superseded } = eventHistory(events, canonical, asOf);
  // Um evento de membro pode ter sido confirmado após a leitura MVCC, mesmo que a transação tenha começado antes.
  return known.filter((event) => !captured.has(event.id) && !superseded.has(event.id) && population.has(canonical(event.applicationId)) &&
    (instantNanoseconds(event.recordedAt) > cutoff || frozenIds.has(event.applicationId) && frozenPopulation.has(frozenCanonical(event.applicationId))))
    .map((event) => ({ ...event, canonicalApplicationId: canonical(event.applicationId) }));
}

export function allocationEligible(row: ApplicationMetricsRow): boolean {
  return row.submissionStatus === 'confirmado' && row.countingEligible && row.canonicalApplicationId === null && row.cycleRelation === 'after_reset';
}
export function nextStableOrder(next: number, preserved: number[]): number {
  return preserved.reduce((value, order) => Math.max(value, order + 1), next);
}
export function batchState(validMembers: number, target = 30): 'open' | 'pending' { return validMembers >= target ? 'pending' : 'open'; }
