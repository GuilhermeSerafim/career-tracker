import { z } from 'zod';

export const TIME_ZONE = 'America/Sao_Paulo' as const;
export const uuidSchema = z.uuid();
export const shortTextSchema = z.string().max(500);
export const longTextSchema = z.string().max(50_000);
export const labelSchema = z.string().trim().min(1).max(200);
export const positiveVersionSchema = z.number().int().positive().max(2_147_483_647);
export const orderSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// O maior inteiro seguro representa um contador esgotado. Toda nova ordem precisa de um sucessor.
export const assignableCycleOrderSchema = orderSchema.max(Number.MAX_SAFE_INTEGER - 1);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const stackSchema = z.array(labelSchema).max(100);

/** Validação gregoriana sem Date/UTC: um dia continua sendo um dia local. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}
export const localDaySchema = z.string().refine(isCalendarDay, 'Informe um dia de calendário válido.');
export const instantSchema = z.string().max(50).regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/)
  .refine((value) => isCalendarDay(value.slice(0, 10)), 'Informe um instante válido com fuso.');
const certainty = z.enum(['exact', 'approximate']);
export const dateValueSchema = z.discriminatedUnion('precision', [
  z.strictObject({ precision: z.literal('unknown'), value: z.null() }),
  z.strictObject({ precision: z.literal('day'), certainty, value: localDaySchema }),
  z.strictObject({ precision: z.literal('month'), certainty, value: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine((v) => !v.startsWith('0000')) }),
  z.strictObject({ precision: z.literal('year'), certainty, value: z.string().regex(/^\d{4}$/).refine((v) => v !== '0000') }),
  z.strictObject({ precision: z.literal('instant'), certainty, value: instantSchema }),
]);
export const submissionStatusSchema = z.enum(['confirmado', 'nao_confirmado', 'nao_enviado']);
export const stageSchema = z.enum(['desconhecida', 'candidatura_enviada', 'triagem', 'avaliacao', 'entrevista', 'proposta', 'contratacao', 'rejeicao', 'desistencia', 'processo_encerrado']);
export const cycleRelationSchema = z.enum(['before_reset', 'after_reset', 'unknown']);
export const opportunityKindSchema = z.enum(['vaga', 'banco_talentos', 'pipeline', 'desconhecido']);
export const evidenceKindSchema = z.enum(['relato_usuario', 'portal_observado', 'email', 'arquivo_local', 'texto_legado', 'outro']);
export const eventKindSchema = z.enum(['envio_confirmado', 'etapa_alterada', 'retorno_substantivo', 'confirmacao_automatica', 'avaliacao', 'entrevista', 'proposta', 'contratacao', 'rejeicao', 'desistencia', 'encerramento', 'nota', 'correcao']);
export const eventStateSchema = z.enum(['convidado', 'agendado', 'concluido', 'informado']);
export const actorSchema = z.strictObject({ kind: z.enum(['owner', 'agent', 'import']), id: labelSchema, ownerId: uuidSchema });
export const versionedSchema = z.strictObject({ id: uuidSchema, version: positiveVersionSchema });
export const metricSchema = z.strictObject({ numerator: z.number().int().nonnegative(), denominator: z.number().int().nonnegative(), ratio: z.number().finite().nonnegative().nullable(), applicationIds: z.array(uuidSchema).max(100_000) });
export const periodSchema = z.strictObject({ from: localDaySchema, to: localDaySchema }).refine((period) => period.from <= period.to, 'O início deve anteceder o fim do período.');
export const applicationMetricsRowSchema = versionedSchema.extend({
  displayId: z.string().regex(/^(N\d{6,}|V\d+)$/), submissionStatus: submissionStatusSchema,
  submittedDate: dateValueSchema, countingEligible: z.boolean(), canonicalApplicationId: uuidSchema.nullable(),
  stage: stageSchema, archivedAt: instantSchema.nullable(), cycleRelation: cycleRelationSchema,
  cycleOrder: orderSchema.nullable(), stack: stackSchema, discoveryChannel: shortTextSchema.nullable(),
  submissionPlatform: shortTextSchema.nullable(), resumeIds: z.array(uuidSchema).max(100),
});
export const linkDataSchema = z.strictObject({
  originalUrl: z.string().min(1).max(4096), comparisonUrl: z.string().min(1).max(4096).nullable(),
  kind: labelSchema, isLocal: z.boolean(), isPrivate: z.boolean(),
}).refine((link) => link.isLocal || /^https?:\/\/[^\s]+$/i.test(link.originalUrl), 'Informe uma URL HTTP(S) ou referência local.');
export const linksSchema = z.array(linkDataSchema).max(50);
export const opportunityFields = {
  company: shortTextSchema.nullable(), title: shortTextSchema.nullable(), platform: shortTextSchema.nullable(),
  tenant: shortTextSchema.nullable(), jobCode: shortTextSchema.nullable(), jobKey: shortTextSchema.nullable(),
  kind: opportunityKindSchema, seniority: shortTextSchema.nullable(), modality: shortTextSchema.nullable(),
  description: longTextSchema.nullable(), stack: stackSchema,
};
export const evidenceFields = {
  kind: evidenceKindSchema, originalText: longTextSchema.nullable(), source: shortTextSchema.nullable(),
  occurredDate: dateValueSchema.nullable(), privateRef: z.string().max(4096).nullable(), localRef: z.string().max(4096).nullable(),
};
export const eventFields = {
  kind: eventKindSchema, state: eventStateSchema, occurredDate: dateValueSchema,
  resultText: longTextSchema.nullable(), scoreValue: z.number().finite().nullable(), scoreUnit: labelSchema.nullable(), sourceText: longTextSchema.nullable(),
};
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type DateValue = z.infer<typeof dateValueSchema>;
export type CycleRelation = z.infer<typeof cycleRelationSchema>;
export type OpportunityKind = z.infer<typeof opportunityKindSchema>;
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type EventKind = z.infer<typeof eventKindSchema>;
export type EventState = z.infer<typeof eventStateSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type Versioned = z.infer<typeof versionedSchema>;
export type Metric = z.infer<typeof metricSchema>;
export type ApplicationMetricsRow = z.infer<typeof applicationMetricsRowSchema>;
export type Period = z.infer<typeof periodSchema>;
