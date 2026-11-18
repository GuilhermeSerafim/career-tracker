import type { ApplicationMetricsRow } from '../shared/model';
import type { AnalyticsEvent, AnalyticsRow } from '../shared/analytics';
import { buildAnalytics } from './metrics.js';
import { toLocalDay } from './dates.js';

export const REVIEW_CALCULATION_VERSION = 'metrics-v1/review-v1';
export function buildReviewSnapshot(rows: AnalyticsRow[], events: AnalyticsEvent[], populationIds: string[], asOf: string, countedIds = populationIds) {
  const population = new Set(populationIds);
  const capturedRows = rows.filter((row) => population.has(row.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const related = new Map<string, AnalyticsRow>();
  const resolved = new Set<string>();
  for (const row of capturedRows) {
    const visited = new Set<string>(); let id = row.canonicalApplicationId;
    while (id !== null) {
      if (visited.has(id)) throw new Error('Ciclo de redirecionamento canônico inválido.');
      if (resolved.has(id)) break;
      visited.add(id); const target = byId.get(id);
      if (!target) throw new Error('Candidatura canônica ausente da projeção.');
      if (!population.has(id)) related.set(id, target);
      id = target.canonicalApplicationId;
    }
    for (const visitedId of visited) resolved.add(visitedId);
  }
  const counted = new Set(countedIds);
  const eligible = capturedRows.filter((row) => counted.has(row.id) && allocationEligible(row));
  const eligibleIds = new Set(eligible.map((row) => row.id));
  const capturedEvents = events.filter((event) => population.has(event.applicationId));
  const knownDays = capturedRows.flatMap((row) => { const day = toLocalDay(row.submittedDate); return day ? [day] : []; }).sort();
  const day = toLocalDay({ precision: 'instant', certainty: 'exact', value: asOf })!;
  // A interpretação canônica exige os alvos, mas só membros elegíveis compõem a coorte.
  const interpretedRows = [...capturedRows, ...related.values()].map((row) => ({ ...row, countingEligible: eligibleIds.has(row.id) }));
  const analytics = buildAnalytics(interpretedRows, capturedEvents, { operation: 'metrics', period: { from: day, to: day }, population: 'confirmed', dimension: 'stack', asOf, dailyGoal: 0, submissionScope: 'all_dates' });
  const effective = new Set(analytics.effectiveEventIds);
  const attribution = new Map(analytics.eventAttribution.map((item) => [item.eventId, item.canonicalApplicationId]));
  const rejectionIds = [...new Set(capturedEvents.filter((event) => effective.has(event.id) && event.kind === 'rejeicao').map((event) => attribution.get(event.id)!).filter((id) => eligibleIds.has(id)))].sort();
  const externalIds = new Set(rows.filter((row) => !population.has(row.id) && row.cycleRelation === 'before_reset').map((row) => row.id));
  const externalEvents = events.filter((event) => externalIds.has(event.applicationId) && !['nota', 'correcao', 'envio_confirmado', 'confirmacao_automatica'].includes(event.kind));
  return {
    schemaVersion: 1 as const, asOf,
    period: knownDays.length ? { from: knownDays[0]!, to: knownDays.at(-1)! } : null,
    populationIds: [...populationIds].sort(), eventIds: capturedEvents.map((event) => event.id).sort(),
    metrics: { ...analytics.conversions, rejection: { numerator: rejectionIds.length, denominator: eligible.length, ratio: eligible.length ? rejectionIds.length / eligible.length : null, applicationIds: rejectionIds } },
    calculationVersion: REVIEW_CALCULATION_VERSION, eligiblePopulationIds: [...eligibleIds].sort(),
    applications: capturedRows, relatedCanonicalApplications: [...related.values()].sort((a, b) => a.id.localeCompare(b.id)),
    events: capturedEvents, coverage: analytics.coverage, distributions: analytics.groups,
    completed: analytics.completed, firstReturn: analytics.firstReturn,
    externalResultApplicationIds: [...new Set(externalEvents.map((event) => event.applicationId))].sort(), externalResultEventIds: externalEvents.map((event) => event.id).sort(),
  };
}

export function allocationEligible(row: ApplicationMetricsRow): boolean {
  return row.submissionStatus === 'confirmado' && row.countingEligible && row.canonicalApplicationId === null && row.cycleRelation === 'after_reset';
}
export function nextStableOrder(next: number, preserved: number[]): number {
  return preserved.reduce((value, order) => Math.max(value, order + 1), next);
}
export function batchState(validMembers: number, target = 30): 'open' | 'pending' { return validMembers >= target ? 'pending' : 'open'; }
