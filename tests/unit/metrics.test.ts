import { describe, expect, it } from 'vitest';
import { buildAnalytics, conversion, countDailySubmissions } from '../../domain/metrics';
import type { AnalyticsEvent, AnalyticsQuery, AnalyticsRow } from '../../shared/analytics';
import type { DateValue } from '../../shared/model';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (value: string): DateValue => ({ precision: 'day', certainty: 'exact', value });
const unknown: DateValue = { precision: 'unknown', value: null };
function row(n: number, patch: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return { id: id(n), version: 1, displayId: `N${String(n).padStart(6, '0')}`, submissionStatus: 'confirmado', submittedDate: day('2026-11-15'), countingEligible: true, canonicalApplicationId: null, stage: 'rejeicao', archivedAt: null, cycleRelation: 'after_reset', cycleOrder: n, stack: ['React'], discoveryChannel: 'Site', submissionPlatform: 'Portal', resumeIds: [], company: null, title: null, seniority: null, modality: null, batchIds: [], ...patch };
}
function event(n: number, application: number, patch: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return { id: id(n), applicationId: id(application), kind: 'retorno_substantivo', state: 'informado', occurredDate: day('2026-11-16'), recordedAt: '2026-11-16T12:00:00Z', supersedesEventId: null, resultText: null, scoreValue: null, scoreUnit: null, sourceText: null, ...patch };
}
const query: AnalyticsQuery = { operation: 'metrics', period: { from: '2026-11-14', to: '2026-11-17' }, population: 'confirmed', dimension: 'stack', asOf: '2026-11-20T12:00:00Z', dailyGoal: 2, submissionScope: 'submitted_in_period' };

describe('explicit analytics populations', () => {
  it('counts deduplicated eligible business dates and preserves a zero denominator', () => {
    const rows = [row(1, { submittedDate: unknown }), row(2, { submittedDate: day('2026-11-14') }), row(3), row(3), row(4, { countingEligible: false }), row(5, { canonicalApplicationId: id(3) })];
    expect(countDailySubmissions(rows, '2026-11-15')).toBe(1);
    expect(conversion([], new Set())).toEqual({ numerator: 0, denominator: 0, ratio: null, applicationIds: [] });
    expect(conversion(rows, new Set([id(3), id(4)]))).toEqual({ numerator: 1, denominator: 3, ratio: 1 / 3, applicationIds: [id(3)] });
  });
  it('keeps history, cohort, event block and overlapping groups distinct', () => {
    const rows = [row(1, { submittedDate: unknown }), row(2, { submittedDate: day('2025-01-01') }), row(3, { stack: ['React', 'TS'], resumeIds: [id(80), id(81)], archivedAt: '2026-11-16T12:00:00Z', cycleOrder: 99 }), row(4, { cycleOrder: null }), row(4)];
    const result = buildAnalytics(rows, [event(20, 2), event(21, 3), event(22, 3), event(23, 3, { kind: 'avaliacao', state: 'convidado' })], query);
    expect(result).toMatchObject({ populations: { allConfirmed: { applicationIds: [id(1), id(2), id(3), id(4)] } } });
    expect(result.populations.submissionCohort.applicationIds).toEqual([id(3), id(4)]);
    expect(result.populations.cycle.count).toBe(3);
    expect(result.conversions.response).toEqual({ numerator: 1, denominator: 2, ratio: 0.5, applicationIds: [id(3)] });
    expect(result.conversions.assessment.numerator).toBe(1);
    expect(result.completed.assessment.count).toBe(0);
    expect(result.eventsInPeriod.applicationIds).toEqual([id(2), id(3)]);
    expect(result.eventsInPeriod.categories.response.count).toBe(2);
    expect(result.groups.stack.map((g) => [g.key, g.count, g.overlapping])).toEqual([['React', 2, true], ['TS', 1, true]]);
    expect(result.groups.sentCv.map((g) => [g.key, g.applicationIds])).toEqual([['sem_cv_informado', [id(4)]], [id(80), [id(3)]], [id(81), [id(3)]]]);
    expect(result.weekly.map((p) => [p.day, p.goal, p.count])).toEqual([['2026-11-09', 4, 2], ['2026-11-16', 4, 0]]);
    expect(result.comparison).toEqual({ actual: 2, goal: 8, difference: -6, applicationIds: [id(3), id(4)] });
    expect(result.coverage.precision.unknown!.applicationIds).toEqual([id(1)]);
  });
  it('uses knowledge cutoff before corrections and never occurrence-date filtering for cohort conversion', () => {
    const events = [event(20, 1, { kind: 'avaliacao', occurredDate: day('2026-12-01') }), event(21, 1, { kind: 'nota', supersedesEventId: id(20), recordedAt: '2026-11-21T12:00:00Z' })];
    expect(buildAnalytics([row(1)], events, query)).toMatchObject({ conversions: { assessment: { numerator: 1 } } });
    const later = buildAnalytics([row(1)], events, { ...query, asOf: '2026-11-22T12:00:00Z' });
    expect(later.conversions.assessment.numerator).toBe(0);
    expect(later.supersededEventIds).toEqual([id(20)]);
    expect(later.effectiveEventIds).toEqual([id(21)]);
  });
  it('computes even median civil days without automatic confirmations changing first return', () => {
    const result = buildAnalytics([row(1, { submittedDate: day('2018-11-03') }), row(2, { submittedDate: day('2018-11-03') })], [event(20, 1, { occurredDate: day('2018-11-05') }), event(21, 2, { occurredDate: day('2018-11-06') }), event(22, 1, { kind: 'confirmacao_automatica', occurredDate: day('2018-11-03') }), event(23, 1, { occurredDate: day('2018-11-07') })], { ...query, submissionScope: 'all_dates' });
    expect(result).toMatchObject({ firstReturn: { medianDays: 2.5 } });
    expect(result.firstReturn.eligibleN).toBe(2);
    expect(result.firstReturn.distribution).toEqual([{ days: 2, applicationIds: [id(1)] }, { days: 3, applicationIds: [id(2)] }]);
  });
  it('reports uncertain, contradictory and absent evidence instead of inventing first returns', () => {
    const rows = [row(1), row(2), row(3), row(4), row(5, { submittedDate: unknown })];
    const events = [event(20, 1, { occurredDate: unknown }), event(21, 1), event(22, 2, { occurredDate: day('2026-11-14') }), event(23, 2), event(24, 3, { occurredDate: { precision: 'month', certainty: 'exact', value: '2026-11' } })];
    const result = buildAnalytics(rows, events, { ...query, submissionScope: 'all_dates' });
    expect(result).toMatchObject({ firstReturn: { eligibleN: 0 } });
    expect(result.firstReturn.medianDays).toBeNull();
    expect(result.firstReturn.exclusions.uncertain_response!.applicationIds).toEqual([id(1), id(3)]);
    expect(result.firstReturn.exclusions.response_before_submission!.applicationIds).toEqual([id(2)]);
    expect(result.firstReturn.exclusions.no_recorded_response!.applicationIds).toEqual([id(4)]);
    expect(result.firstReturn.exclusions.imprecise_submission!.applicationIds).toEqual([id(5)]);
  });
  it('applies all supplied metadata filters to metrics and drilldowns without inferring triage response', () => {
    const rows = [row(1, { company: 'Acme', title: 'Dev', seniority: 'Senior', modality: 'Remoto', batchIds: [id(90)] }), row(2)];
    const result = buildAnalytics(rows, [event(20, 1, { kind: 'etapa_alterada' })], { ...query, filters: { company: ['Acme'], title: ['Dev'], seniority: ['Senior'], modality: ['Remoto'], batch: [id(90)], stack: ['React'], platform: ['Portal'], channel: ['Site'], status: ['confirmado'], stage: ['rejeicao'], archived: 'include' } });
    expect(result).toMatchObject({ populations: { selected: { applicationIds: [id(1)] } } });
    expect(result.conversions.response.denominator).toBe(1);
    expect(result.conversions.response.numerator).toBe(0);
    expect(result.daily.find((p) => p.day === '2026-11-15')?.applicationIds).toEqual([id(1)]);
  });
});



it('flags a definitely earlier imprecise response as a data issue and allows proven later imprecision', () => {
  const result = buildAnalytics([row(1), row(2)], [event(20, 1, { occurredDate: { precision: 'month', certainty: 'exact', value: '2026-10' } }), event(21, 1), event(22, 2), event(23, 2, { occurredDate: { precision: 'month', certainty: 'exact', value: '2026-12' } })], query);
  expect(result.firstReturn.exclusions.response_before_submission?.applicationIds).toEqual([id(1)]);
  expect(result.firstReturn.applicationIds).toEqual([id(2)]);
  expect(result.firstReturn.medianDays).toBe(1);
});
it('keeps status population separate from date scope and rejects missing filter metadata', () => {
  const rows = [row(1, { submittedDate: unknown }), row(2, { submissionStatus: 'nao_enviado' }), row(3, { submissionStatus: 'nao_confirmado' }), row(4, { archivedAt: '2026-11-16T12:00:00Z' })];
  const all = buildAnalytics(rows, [], { ...query, population: 'all', submissionScope: 'all_dates' });
  expect(all.populations.selected.count).toBe(4);
  expect(all.conversions.response.denominator).toBe(2);
  expect(all.populations.submissionCohort.applicationIds).toEqual([id(4)]);
  expect(buildAnalytics(rows, [], { ...query, population: 'saved' }).conversions.response.ratio).toBeNull();
  expect(buildAnalytics(rows, [], { ...query, filters: { archived: 'exclude' } }).populations.allConfirmed.applicationIds).toEqual([id(1)]);
  const invalid = { ...row(1), company: undefined };
  expect(() => buildAnalytics([invalid as unknown as AnalyticsRow], [], query)).toThrow();
  expect(() => buildAnalytics(rows, [], { ...query, filters: { unexpected: ['x'] } } as unknown as AnalyticsQuery)).toThrow();
});
it('counts completed interview once without interpreting scores or registration time as an event date', () => {
  const events = [event(20, 1, { kind: 'entrevista', state: 'agendado' }), event(21, 1, { kind: 'entrevista', state: 'concluido', scoreValue: 100, scoreUnit: '%' }), event(22, 1, { kind: 'confirmacao_automatica', occurredDate: unknown })];
  const result = buildAnalytics([row(1, { submittedDate: day('2025-01-01') })], events, { ...query, submissionScope: 'all_dates' });
  expect(result.completed.interview.applicationIds).toEqual([id(1)]);
  expect(result.conversions.interview.numerator).toBe(1);
  expect(result.conversions.offer.numerator).toBe(0);
  expect(result.eventsInPeriod.eventIds).toEqual([id(20), id(21)]);
  expect(result.populations.submissionCohort.count).toBe(0);
  expect(result.firstReturn.exclusions.no_recorded_response?.applicationIds).toEqual([id(1)]);
});
it('attributes redirected history to canonical UUIDs while preserving original event IDs', () => {
  const rows = [row(1), row(2, { canonicalApplicationId: id(1), countingEligible: false }), row(3, { canonicalApplicationId: id(2), countingEligible: false })];
  const result = buildAnalytics(rows, [event(20, 3), event(21, 1), event(22, 2, { kind: 'entrevista' })], query);
  expect(result.conversions.interview).toEqual({ numerator: 1, denominator: 1, ratio: 1, applicationIds: [id(1)] });
  expect(result.conversions.response.numerator).toBe(1);
  expect(result.firstReturn.applicationIds).toEqual([id(1)]);
  expect(result.eventsInPeriod.applicationIds).toEqual([id(1)]);
  expect(result.eventsInPeriod.eventIds).toEqual([id(20), id(21), id(22)]);
  expect(result.eventAttribution).toContainEqual({ eventId: id(20), originalApplicationId: id(3), canonicalApplicationId: id(1) });
  expect(() => buildAnalytics([row(2, { canonicalApplicationId: id(99) })], [], query)).toThrow();
  expect(() => buildAnalytics([row(1, { canonicalApplicationId: id(2) }), row(2, { canonicalApplicationId: id(1) })], [], query)).toThrow();
  expect(() => buildAnalytics([row(1)], [event(20, 99)], query)).toThrow();
  const corrected = buildAnalytics(rows, [event(20, 2), event(21, 1, { kind: 'nota', supersedesEventId: id(20) })], query);
  expect(corrected.conversions.response.numerator).toBe(0);
  expect(corrected.supersededEventIds).toEqual([id(20)]);
});
it('treats UUID casing semantically in filters, duplicate rows, events and direct conversion', () => {
  const lower = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const upper = lower.toUpperCase();
  const rows = [row(1, { id: lower, batchIds: [lower], stack: ['TypeScript'] }), row(1, { id: upper, batchIds: [upper], stack: ['TypeScript'] })];
  const result = buildAnalytics(rows, [event(20, 1, { applicationId: upper })], { ...query, filters: { batch: [upper], stack: ['TypeScript'] } });
  expect(result.conversions.response).toEqual({ numerator: 1, denominator: 1, ratio: 1, applicationIds: [lower] });
  expect(result.populations.allConfirmed.applicationIds).toEqual([lower]);
  expect(buildAnalytics([rows[0]!], [], { ...query, filters: { batch: [upper] } }).populations.allConfirmed.applicationIds).toEqual([lower]);
  expect(conversion(rows, new Set([upper]))).toEqual({ numerator: 1, denominator: 1, ratio: 1, applicationIds: [lower] });
});

describe('Task 6 specification regressions', () => {
  it.each([
    ['company', ['Fictional Acme']], ['title', ['Dev']], ['stack', ['React', 'TS']],
    ['seniority', ['Senior']], ['modality', ['Remoto']], ['channel', ['Site']],
    ['platform', ['Portal']], ['status', ['confirmado']], ['stage', ['rejeicao']], ['batch', [id(90), id(91)]],
  ] as const)('honors selected dimension %s with the same cohort and drilldown IDs', (dimension, keys) => {
    const result = buildAnalytics([row(1, { company: 'Fictional Acme', title: 'Dev', stack: ['React', 'TS'], seniority: 'Senior', modality: 'Remoto', batchIds: [id(90), id(91)] })], [event(20, 1)], { ...query, dimension });
    expect(result).toMatchObject({ selectedGrouping: { dimension, groups: keys.map((key) => ({ key, applicationIds: [id(1)], count: 1, conversions: { response: { numerator: 1, denominator: 1 } } })) } });
    expect(result.groups.sentCv[0]?.applicationIds).toEqual([id(1)]);
  });
  it('keeps arbitrary business labels as serializable strings even when they name prototype properties', () => {
    const names = ['constructor', 'toString', '__proto__', 'unknown'];
    const result = buildAnalytics([row(1, { stack: names })], [], query);
    const serialized = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(serialized.groups.stack.map((group) => group.label).sort()).toEqual([...names].sort());
  });
  it('rejects oversized input arrays without inspecting their elements or truncating them', () => {
    const tooManyRows = new Array<AnalyticsRow>(100_001).fill(row(1));
    const tooManyEvents = new Array<AnalyticsEvent>(100_001).fill(event(20, 1));
    Object.defineProperty(tooManyRows, 0, { get() { throw new Error('Elemento não deve ser lido'); } });
    Object.defineProperty(tooManyEvents, 0, { get() { throw new Error('Elemento não deve ser lido'); } });
    expect(() => buildAnalytics(tooManyRows, [], query)).toThrow(/100000/);
    expect(() => buildAnalytics([row(1)], tooManyEvents, query)).toThrow(/100000/);
  });
  it('accepts exactly 100000 input entries and deduplicates without changing historical scope', () => {
    const result = buildAnalytics(new Array<AnalyticsRow>(100_000).fill(row(1, { submittedDate: day('1900-01-01') })), new Array<AnalyticsEvent>(100_000).fill(event(20, 1)), { ...query, submissionScope: 'all_dates' });
    expect(result.populations.allConfirmed.applicationIds).toEqual([id(1)]);
    expect(result.conversions.response.denominator).toBe(1);
  }, 30_000);
  it('rejects 3661 inclusive days and accepts exactly 3660', () => {
    // 2020-01-01 through 2030-01-07 is 3660 Gregorian days, including leap years.
    expect(() => buildAnalytics([], [], { ...query, period: { from: '2020-01-01', to: '2030-01-08' } })).toThrow();
    expect(buildAnalytics([], [], { ...query, period: { from: '2020-01-01', to: '2030-01-07' } }).daily).toHaveLength(3660);
  });
  it('keeps distinct company denominators and reached IDs in their own selected groups', () => {
    const result = buildAnalytics([row(1, { company: 'Fictional Acme' }), row(2, { company: 'Fictional Bravo' }), row(3, { company: 'Fictional Acme' })], [event(20, 1)], { ...query, dimension: 'company' });
    expect(result.selectedGrouping.groups.map((group) => [group.key, group.applicationIds, group.conversions.response])).toEqual([
      ['Fictional Acme', [id(1), id(3)], { numerator: 1, denominator: 2, ratio: 0.5, applicationIds: [id(1)] }],
      ['Fictional Bravo', [id(2)], { numerator: 0, denominator: 1, ratio: 0, applicationIds: [] }],
    ]);
  });
});
it('keeps literal sentinel business text distinct from missing data', () => {
  const result = buildAnalytics([row(1, { stack: ['sem_stack_informada'] }), row(2, { stack: [] })], [], { ...query, dimension: 'stack' });
  const serialized = JSON.parse(JSON.stringify(result)) as typeof result;
  const expected = [
    { key: 'sem_stack_informada', label: 'sem_stack_informada', isMissing: false, ids: [id(1)] },
    { key: 'sem_stack_informada', label: 'Sem stack informada', isMissing: true, ids: [id(2)] },
  ];
  for (const groups of [serialized.groups.stack, serialized.selectedGrouping.groups]) expect(groups.map((group) => ({ key: group.key, label: group.label, isMissing: group.isMissing, ids: group.applicationIds }))).toEqual(expected);
});

describe('Task 6 quality regressions', () => {
  it('orders negative epochs, missing fractions and nanosecond offsets exactly', () => {
    const events = [event(20, 1, { recordedAt: '1969-12-31T20:59:59.999999999-03:00' }), event(21, 1, { recordedAt: '1970-01-01T00:00:00.000000001Z' }), event(22, 1, { recordedAt: '1970-01-01T01:00:00+01:00' })];
    expect(buildAnalytics([row(1)], events, { ...query, asOf: '1970-01-01T00:00:00Z' }).effectiveEventIds).toEqual([id(20), id(22)]);
  });
  it('preserves nanoseconds at the knowledge cutoff before applying future corrections', () => {
    const events = [event(20, 1, { kind: 'avaliacao', recordedAt: '2026-11-16T12:00:00.000000001Z' }), event(21, 1, { kind: 'nota', supersedesEventId: id(20), recordedAt: '2026-11-16T09:00:00.0009-03:00' })];
    const result = buildAnalytics([row(1)], events, { ...query, asOf: '2026-11-16T12:00:00.0001Z' });
    expect(result.conversions.assessment.numerator).toBe(1);
    expect(result.supersededEventIds).toEqual([]);
    expect(result.effectiveEventIds).toEqual([id(20)]);
    expect(buildAnalytics([row(1)], events, { ...query, asOf: '2026-11-16T12:00:00.000900000Z' }).supersededEventIds).toEqual([id(20)]);
  });
  it('flags a response preceding submission inside the same millisecond', () => {
    const result = buildAnalytics([row(1, { submittedDate: { precision: 'instant', certainty: 'exact', value: '2026-11-15T12:00:00.0009Z' } })], [event(20, 1, { occurredDate: { precision: 'instant', certainty: 'exact', value: '2026-11-15T09:00:00.0001-03:00' } })], query);
    expect(result.firstReturn.exclusions.response_before_submission?.applicationIds).toEqual([id(1)]);
    expect(result.firstReturn.eligibleN).toBe(0);
  });
  it('handles long root-first canonical and predecessor chains iteratively with exact attribution', () => {
    const count = 100_000;
    const rows = Array.from({ length: count }, (_, i) => row(i + 1, i ? { canonicalApplicationId: id(i), countingEligible: false } : {}));
    const events = Array.from({ length: count }, (_, i) => event(100_000 + i, i + 1, { supersedesEventId: i ? id(99_999 + i) : null }));
    const result = buildAnalytics(rows, events, query);
    expect(result.conversions.response).toEqual({ numerator: 1, denominator: 1, ratio: 1, applicationIds: [id(1)] });
    expect(result.effectiveEventIds).toEqual([id(199_999)]);
    expect(result.supersededEventIds).toHaveLength(99_999);
    expect(result.eventAttribution.at(-1)).toEqual({ eventId: id(199_999), originalApplicationId: id(100_000), canonicalApplicationId: id(1) });
    const reversed = buildAnalytics([...rows].reverse(), [...events].reverse(), query);
    expect(reversed.effectiveEventIds).toEqual([id(199_999)]);
    expect(reversed.conversions.response.applicationIds).toEqual([id(1)]);
    const cyclic = events.map((value, index) => index === 0 ? { ...value, supersedesEventId: id(199_999) } : value);
    expect(() => buildAnalytics(rows, cyclic, query)).toThrow(/Ciclo/);
    expect(() => buildAnalytics([row(1)], [event(20, 1, { supersedesEventId: id(21) }), event(21, 1, { supersedesEventId: id(20) })], query)).toThrow(/Ciclo/);
    expect(() => buildAnalytics([row(1), row(2)], [event(20, 1), event(21, 2, { supersedesEventId: id(20) })], query)).toThrow(/compatível/);
    expect(() => buildAnalytics([row(1)], [event(20, 1, { supersedesEventId: id(99) })], query)).toThrow(/compatível/);
  }, 30_000);
});
