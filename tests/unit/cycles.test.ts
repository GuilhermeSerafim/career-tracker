import { describe, expect, it } from 'vitest';
import { allocationEligible, batchState, nextStableOrder, buildReviewSnapshot, laterReviewEvents } from '../../domain/cycles';
import { reviewSnapshotSchema } from '../../shared/transfer';
import type { AnalyticsRow, AnalyticsEvent } from '../../shared/analytics';
import { commandSchema } from '../../shared/commands';
import { transferEntitySchema } from '../../shared/transfer';
import { appFixture } from '../fixtures/career';

describe('alocação estável por membros válidos', () => {
  it('29 fica aberto; 30 fica pendente independentemente da maior ordem', () => {
    expect(batchState(29)).toBe('open'); expect(batchState(30)).toBe('pending');
    expect(batchState(3)).toBe('open');
  });
  it('preserva lacunas e nunca reutiliza ordens importadas ou reservadas', () => {
    expect(nextStableOrder(2, [1, 73])).toBe(74);
    expect(nextStableOrder(90, [1, 73])).toBe(90);
  });
  it('só conta confirmação canônica elegível explicitamente após reinício', () => {
    expect(allocationEligible(appFixture())).toBe(true);
    for (const patch of [{ cycleRelation: 'before_reset' }, { cycleRelation: 'unknown' }, { countingEligible: false }, { canonicalApplicationId: appFixture().id }, { submissionStatus: 'nao_confirmado' }]) {
      expect(allocationEligible(appFixture(patch as Partial<ReturnType<typeof appFixture>>))).toBe(false);
    }
  });
  it('congela IDs, CVs reais, lacunas e resultados externos com denominadores explícitos', () => {
    const first: AnalyticsRow = { ...appFixture(), company: null, title: null, seniority: null, modality: null, batchIds: [] };
    const external = { ...first, id: '00000000-0000-4000-8000-000000000102', cycleRelation: 'before_reset' as const };
    const event: AnalyticsEvent = { id: '00000000-0000-4000-8000-000000000201', applicationId: first.id, kind: 'entrevista', state: 'agendado', occurredDate: { precision: 'unknown', value: null }, recordedAt: '2026-11-16T12:00:00Z', supersedesEventId: null, resultText: 'Convite.', scoreValue: null, scoreUnit: null, sourceText: null };
    const historicalEvent = { ...event, id: '00000000-0000-4000-8000-000000000202', applicationId: external.id };
    const snapshot = buildReviewSnapshot([first, external], [event, historicalEvent], [first.id], '2026-11-16T12:00:00Z');
    expect(snapshot.metrics.interview).toMatchObject({ numerator: 1, denominator: 1 });
    expect(snapshot.eventIds).toEqual([event.id]); expect(snapshot.externalResultEventIds).toEqual([historicalEvent.id]);
    expect(snapshot.externalResultApplicationIds).toEqual([external.id]);
    expect(snapshot.coverage.missing.sentCv?.applicationIds).toEqual([first.id]);
    expect(snapshot.distributions.sentCv[0]?.isMissing).toBe(true);
    expect(reviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(buildReviewSnapshot([first], [event], [first.id], snapshot.asOf, []).metrics.interview.denominator).toBe(0);
  });
  it('retém interpretação do alias sem incluir vencedor externo no denominador', () => {
    const root: AnalyticsRow = { ...appFixture(), company: null, title: null, seniority: null, modality: null, batchIds: [] };
    const alias = { ...root, id: '00000000-0000-4000-8000-000000000102', canonicalApplicationId: root.id, countingEligible: false };
    const snapshot = buildReviewSnapshot([alias, root], [], [alias.id], '2026-11-16T12:00:00Z');
    expect(snapshot.populationIds).toEqual([alias.id]);
    expect(snapshot.metrics.response.denominator).toBe(0);
    expect(snapshot).toHaveProperty('relatedCanonicalApplications', [root]);
  });
  it('transfere ciclo atual explícito e mapeamento durável sem perder data desconhecida', () => {
    const id = appFixture().id;
    const resetDate = { precision: 'unknown', value: null };
    expect(commandSchema.parse({ operation: 'start_cycle', clientId: id, resetDate, resetMarker: null })).toMatchObject({ resetDate });
    const cycle = { formatVersion: 1, table: 'cycles', data: { id, version: 1, createdAt: '2026-11-16T12:00:00Z', updatedAt: '2026-11-16T12:00:00Z', resetDate, resetMarker: null, nextOrder: 74, isCurrent: true } };
    expect(transferEntitySchema.parse(cycle)).toEqual(cycle);
    const mapping = { formatVersion: 1, table: 'creation_requests', data: { id, createdAt: '2026-11-16T12:00:00Z', clientId: id, payloadHash: 'a'.repeat(64), entityType: 'cycle', resultApplicationId: null, resultContactId: null, resultTaskId: null, resultEventId: null, resultCycleId: id } };
    expect(transferEntitySchema.parse(mapping)).toEqual(mapping);
    expect(transferEntitySchema.safeParse({ ...mapping, data: { ...mapping.data, resultApplicationId: id } }).success).toBe(false);
  });
  it('atribui evidência do alias ao vencedor já pertencente ao lote sem contar duas vezes', () => {
    const root: AnalyticsRow = { ...appFixture(), company: null, title: null, seniority: null, modality: null, batchIds: [] };
    const alias = { ...root, id: '00000000-0000-4000-8000-000000000102', canonicalApplicationId: root.id, countingEligible: false };
    const event: AnalyticsEvent = { id: '00000000-0000-4000-8000-000000000201', applicationId: alias.id, kind: 'retorno_substantivo', state: 'informado', occurredDate: { precision: 'unknown', value: null }, recordedAt: '2026-11-16T12:00:00Z', supersedesEventId: null, resultText: null, scoreValue: null, scoreUnit: null, sourceText: null };
    expect(buildReviewSnapshot([alias, root], [event], [alias.id, root.id], event.recordedAt).metrics.response).toMatchObject({ numerator: 1, denominator: 1, applicationIds: [root.id] });
  });
  it('shows a member event committed after the projection even if its transaction timestamp is earlier', () => {
    const member: AnalyticsRow = { ...appFixture(), company: null, title: null, seniority: null, modality: null, batchIds: [] };
    const outside = { ...member, id: '00000000-0000-4000-8000-000000000102' };
    const capturedAt = '2026-11-16T12:00:00.000002Z';
    const snapshot = buildReviewSnapshot([member, outside], [], [member.id], capturedAt);
    const memberEvent: AnalyticsEvent = { id: '00000000-0000-4000-8000-000000000201', applicationId: member.id, kind: 'entrevista', state: 'concluido', occurredDate: { precision: 'unknown', value: null }, recordedAt: '2026-11-16T12:00:00.000001Z', supersedesEventId: null, resultText: null, scoreValue: null, scoreUnit: null, sourceText: null };
    const outsideEvent = { ...memberEvent, id: '00000000-0000-4000-8000-000000000202', applicationId: outside.id };
    const liveRows = [member, { ...outside, canonicalApplicationId: member.id, countingEligible: false }];
    expect(laterReviewEvents(liveRows, [memberEvent, outsideEvent], '2026-11-16T12:00:01Z', snapshot))
      .toEqual([{ ...memberEvent, canonicalApplicationId: member.id }]);
  });
  it('transfere projeções históricas congeladas sem aparar rótulos ou unidades', () => {
    const row: AnalyticsRow = { ...appFixture(), stack: [' .NET '], company: null, title: null, seniority: null, modality: null, batchIds: [] };
    const event: AnalyticsEvent = { id: '00000000-0000-4000-8000-000000000201', applicationId: row.id, kind: 'avaliacao', state: 'concluido', occurredDate: { precision: 'unknown', value: null }, recordedAt: '2026-11-16T12:00:00Z', supersedesEventId: null, resultText: null, scoreValue: 80, scoreUnit: ' pontos ', sourceText: null };
    const snapshot = buildReviewSnapshot([row], [event], [row.id], event.recordedAt);
    expect(reviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});
