import { z } from 'zod';
import { applicationMetricsRowSchema, eventFields, instantSchema, shortTextSchema, uuidSchema, type Metric } from './model.js';
import { querySchema } from './queries.js';

/** Metadados obrigatórios para filtros; null é desconhecido, [] significa ausência de associação.
 * resumeIds contém somente associações ativas explicitamente relatadas como CV enviado.
 * O chamador fornece uma projeção consistente por UUID; não se reconstrói história por timestamps.
 */
export const analyticsRowSchema = applicationMetricsRowSchema.extend({ company: shortTextSchema.nullable(), title: shortTextSchema.nullable(), seniority: shortTextSchema.nullable(), modality: shortTextSchema.nullable(), batchIds: z.array(uuidSchema).max(100) });
export const analyticsEventSchema = z.strictObject({ id: uuidSchema, applicationId: uuidSchema, ...eventFields, recordedAt: instantSchema, supersedesEventId: uuidSchema.nullable() });
/** asOf limita conhecimento dos eventos por recordedAt, nunca sua ocorrência.
 * population seleciona estados de envio; submissionScope escolhe o denominador de conversão.
 * Séries e metas usam todos os dias do período; eventos no período usam occurredDate.
 * Totais históricos e cobertura mantêm datas desconhecidas; arquivadas entram por padrão.
 */
export const analyticsQuerySchema = querySchema.options[2].extend({ asOf: instantSchema, dailyGoal: z.number().int().nonnegative().max(100_000), submissionScope: z.enum(['submitted_in_period', 'all_dates']) });
export type AnalyticsRow = z.infer<typeof analyticsRowSchema>;
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
/** Limites de entrada, sem truncar histórico: até 100000 registros por coleção e 3660 dias inclusivos. */
export const MAX_ANALYTICS_ENTRIES = 100_000;
export const MAX_ANALYTICS_DAYS = 3660;
export type ReachedCategory = 'response' | 'assessment' | 'interview' | 'offer';
export interface Population { label: string; applicationIds: string[]; count: number }
export interface SeriesPoint extends Population { day: string; goal: number; difference: number }
/** A identidade do grupo é a tupla (key, isMissing). Interfaces/gráficos devem usar ambos,
 * nunca key isoladamente: um texto real pode coincidir com a chave da categoria ausente. */
export interface AnalyticsGroup extends Population { key: string; isMissing: boolean; overlapping: boolean; conversions: Record<ReachedCategory, Metric> }
export interface AnalyticsResult {
  asOf: string;
  query: AnalyticsQuery;
  populations: { selected: Population; allConfirmed: Population; submissionCohort: Population; conversionCohort: Population; cycle: Population };
  coverage: { precision: Record<string, Population>; certainty: Record<string, Population>; missing: Record<string, Population> };
  conversions: Record<ReachedCategory, Metric>;
  completed: Record<ReachedCategory, Population>;
  groups: Record<'stack' | 'discoveryChannel' | 'submissionPlatform' | 'sentCv', AnalyticsGroup[]>;
  selectedGrouping: { dimension: AnalyticsQuery['dimension']; groups: AnalyticsGroup[] };
  daily: SeriesPoint[];
  weekly: SeriesPoint[];
  comparison: { actual: number; goal: number; difference: number; applicationIds: string[] };
  eventsInPeriod: { applicationIds: string[]; eventIds: string[]; categories: Record<ReachedCategory, Population> };
  effectiveEventIds: string[];
  supersededEventIds: string[];
  eventAttribution: { eventId: string; originalApplicationId: string; canonicalApplicationId: string }[];
  firstReturn: { medianDays: number | null; eligibleN: number; applicationIds: string[]; distribution: { days: number; applicationIds: string[] }[]; exclusions: Record<string, Population> };
}
