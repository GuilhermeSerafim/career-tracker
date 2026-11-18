import type { ApplicationMetricsRow, DateValue } from '../../shared/model';

export const unknownDate = { precision: 'unknown', value: null } as const satisfies DateValue;
export const day = (value: string): DateValue => ({ precision: 'day', certainty: 'exact', value });
export function appFixture(overrides: Partial<ApplicationMetricsRow> = {}): ApplicationMetricsRow {
  return {
    id: '00000000-0000-4000-8000-000000000101', displayId: 'N000001', submissionStatus: 'confirmado',
    submittedDate: day('2026-11-10'), countingEligible: true, canonicalApplicationId: null,
    stage: 'candidatura_enviada', archivedAt: null, cycleRelation: 'after_reset', cycleOrder: 1,
    stack: ['.NET'], discoveryChannel: null, submissionPlatform: null, resumeIds: [], version: 1,
    ...overrides,
  };
}
