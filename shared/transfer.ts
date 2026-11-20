import { z } from 'zod';
import { analyticsRowSchema, analyticsEventSchema } from './analytics.js';
import {
  TIME_ZONE, actorSchema, cycleRelationSchema, dateValueSchema, eventFields, evidenceFields,
  instantSchema, linkDataSchema, longTextSchema, metricSchema, opportunityFields,
  orderSchema, periodSchema, sha256Schema, shortTextSchema, stageSchema,
  submissionStatusSchema, uuidSchema, versionedSchema,
} from './model.js';

/** Envelope v1 reservado para o restore completo. Proprietário é definido pelo destino verificado. */
const base = versionedSchema.extend({ createdAt: instantSchema, updatedAt: instantSchema });
const ids = z.array(uuidSchema).max(100_000);
const issues = z.array(longTextSchema).max(1000);
// Transferência valida o histórico sem normalizá-lo. Schemas interativos podem aparar espaços.
const historicalLabelSchema = z.string().min(1).max(200);
const historicalKeySchema = z.string().max(200);
const historicalStackSchema = z.array(historicalLabelSchema).max(100);
function historicalRecordSchema<T>(valueSchema: z.ZodType<T>) {
  // Mantém o registro validado: não descarta __proto__ nem atribui chaves a outro objeto.
  return z.custom<Record<string, T>>((input) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(input);
    if (keys.length > 1000) return false;
    return keys.every((key) => {
      if (typeof key !== 'string' || !historicalKeySchema.safeParse(key).success) return false;
      const property = Object.getOwnPropertyDescriptor(input, key);
      return property?.enumerable === true && Object.hasOwn(property, 'value')
        && valueSchema.safeParse(property.value).success;
    });
  }, 'Informe um registro JSON com chaves e valores válidos.');
}
export const MAX_SOURCE_ARCHIVE_BYTES = 50 * 1024 * 1024;
const sourceTextSchema = z.string().max(MAX_SOURCE_ARCHIVE_BYTES)
  .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_SOURCE_ARCHIVE_BYTES, 'O arquivo-fonte excede 50 MiB.');
function validSourceBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length / 4 * 3 - padding > MAX_SOURCE_ARCHIVE_BYTES) return false;
  // Varredura linear, sem pilha de backtracking nem decodificação de outro buffer de 50 MiB.
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  return true;
}
const sourceBytesSchema = z.string().max(Math.ceil(MAX_SOURCE_ARCHIVE_BYTES / 3) * 4).refine(validSourceBase64);
const historicalAnalyticsRowSchema = analyticsRowSchema.safeExtend({ stack: historicalStackSchema });
const historicalAnalyticsEventSchema = analyticsEventSchema.safeExtend({ scoreUnit: historicalLabelSchema.nullable() });
// Auditoria guarda valores JSON históricos, inclusive campos de versões anteriores do modelo.
type HistoricalJson = string | number | boolean | null | HistoricalJson[] | { [key: string]: HistoricalJson };
function historicalJsonAtDepth(depth: number): z.ZodType<HistoricalJson> {
  const scalar = z.union([longTextSchema, z.number().finite(), z.boolean(), z.null()]);
  if (depth === 0) return scalar;
  const child = historicalJsonAtDepth(depth - 1);
  return z.union([scalar, z.array(child).max(100_000), historicalRecordSchema(child)]);
}
const historicalJsonSchema = historicalJsonAtDepth(16);
export const reviewSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), asOf: instantSchema, period: periodSchema.nullable(),
  populationIds: ids, eventIds: ids, metrics: historicalRecordSchema(metricSchema),
  calculationVersion: shortTextSchema.optional(), eligiblePopulationIds: ids.optional(),
  applications: z.array(historicalAnalyticsRowSchema).max(100_000).optional(), events: z.array(historicalAnalyticsEventSchema).max(100_000).optional(),
  // A partir de review-v2, guarda também os caminhos canônicos dos eventos capturados.
  relatedCanonicalApplications: z.array(historicalAnalyticsRowSchema).max(100_000).optional(),
  eventEvidence: historicalJsonSchema.optional(), resumeRefs: historicalJsonSchema.optional(),
  coverage: historicalJsonSchema.optional(), distributions: historicalJsonSchema.optional(), completed: historicalJsonSchema.optional(), firstReturn: historicalJsonSchema.optional(),
  // IDs fisicamente visíveis no corte da review-v2 para casos externos com histórico de resultados.
  externalEventHistoryIds: ids.optional(),
  externalResultApplicationIds: ids.optional(), externalResultEventIds: ids.optional(),
});
function validSourceAudit(value: unknown, diff = false): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1000) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !historicalKeySchema.safeParse(key).success || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const item: unknown = descriptor.value;
    if (key !== 'original_text' && key !== 'original_bytes') return historicalJsonSchema.safeParse(item).success;
    const valid = (input: unknown) => {
      if (input === null) return true;
      if (typeof input !== 'string') return false;
      if (key === 'original_text') return sourceTextSchema.safeParse(input).success;
      if (!input.startsWith('\\x') || input.length % 2 !== 0 || input.length > 2 + MAX_SOURCE_ARCHIVE_BYTES * 2) return false;
      for (let i = 2; i < input.length; i++) {
        const code = input.charCodeAt(i);
        if (!(code >= 48 && code <= 57 || code >= 97 && code <= 102 || code >= 65 && code <= 70)) return false;
      }
      return true;
    };
    if (!diff) return valid(item);
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return Reflect.ownKeys(item).every((side) => {
      const property = Object.getOwnPropertyDescriptor(item, side);
      return (side === 'before' || side === 'after') && property?.enumerable && Object.hasOwn(property, 'value') && valid(property.value);
    });
  });
}
const schemas = {
  owner_settings: base.extend({ dailyGoal: z.number().int().positive(), timezone: z.literal(TIME_ZONE) }),
  opportunities: base.extend({ ...opportunityFields, stack: historicalStackSchema }),
  applications: base.extend({
    opportunityId: uuidSchema, legacyId: z.string().regex(/^V\d+$/).nullable(), displayId: z.string().regex(/^(N\d{6,}|V\d+)$/),
    track: shortTextSchema.nullable(), applicationInstance: historicalLabelSchema,
    submissionStatus: submissionStatusSchema, submittedDate: dateValueSchema, stage: stageSchema,
    discoveryChannel: shortTextSchema.nullable(), submissionPlatform: shortTextSchema.nullable(), notes: longTextSchema.nullable(),
    cycleRelation: cycleRelationSchema, cycleOrder: orderSchema.nullable(), countingEligible: z.boolean(), archivedAt: instantSchema.nullable(),
    canonicalApplicationId: uuidSchema.nullable(), legacyRegisteredDate: dateValueSchema, legacyResumeText: longTextSchema.nullable(),
  }).refine((v) => v.legacyId === null ? v.displayId.startsWith('N') : v.displayId === v.legacyId, 'O identificador visível deve preservar o legado.'),
  contacts: base.extend({ name: shortTextSchema.nullable(), notes: longTextSchema.nullable() }),
  links: linkDataSchema.safeExtend({ ...base.shape, kind: historicalLabelSchema, opportunityId: uuidSchema.nullable(), applicationId: uuidSchema.nullable(), contactId: uuidSchema.nullable() })
    .refine((v) => v.opportunityId !== null || v.applicationId !== null || v.contactId !== null, 'Um link deve ter alvo.'),
  resume_refs: base.extend({ label: shortTextSchema.nullable(), stack: historicalStackSchema, language: shortTextSchema.nullable(), localRef: z.string().max(4096).nullable() }),
  // Campos opcionais aceitam envelopes v1 anteriores; restore interpreta ausência como true/false.
  application_resumes: base.extend({ applicationId: uuidSchema, resumeId: uuidSchema, isActive: z.boolean().optional() }),
  evidence: base.extend({ ...evidenceFields, capturedAt: instantSchema }),
  events: base.extend({ ...eventFields, scoreUnit: historicalLabelSchema.nullable(), applicationId: uuidSchema, evidenceId: uuidSchema.nullable(), supersedesEventId: uuidSchema.nullable() }),
  tasks: base.extend({ applicationId: uuidSchema.nullable(), contactId: uuidSchema.nullable(), title: historicalLabelSchema, dueDate: dateValueSchema, completedDate: dateValueSchema, status: z.enum(['pending', 'completed', 'cancelled']) })
    .refine((v) => v.applicationId !== null || v.contactId !== null, 'Uma tarefa deve ter alvo.'),
  cycles: base.extend({ resetDate: dateValueSchema, resetMarker: shortTextSchema.nullable(), nextOrder: orderSchema, isCurrent: z.boolean().optional() }),
  batches: base.extend({ cycleId: uuidSchema, batchNumber: orderSchema, status: z.enum(['open', 'pending', 'closed']), target: orderSchema, rectificationPending: z.boolean().optional() }),
  batch_members: base.extend({ batchId: uuidSchema, applicationId: uuidSchema, capturedOrder: orderSchema, allocation: z.enum(['counted', 'excluded']), eligible: z.boolean() }),
  review_versions: base.extend({ batchId: uuidSchema, versionNumber: orderSchema, type: z.enum(['original', 'revision', 'rectification']), snapshot: reviewSnapshotSchema, populationIds: ids, eventIds: ids, narrative: longTextSchema.nullable(), decisions: z.array(longTextSchema).max(100), predecessorId: uuidSchema.nullable(), calculationVersion: shortTextSchema.nullable().optional(), closedAt: instantSchema.nullable().optional(), reason: longTextSchema.nullable().optional(), evidenceId: uuidSchema.nullable().optional(), originalMarkdown: longTextSchema.nullable().optional(), importProvenance: historicalJsonSchema.nullable().optional() }),
  import_runs: base.extend({ importerVersion: historicalLabelSchema, sourceSetHash: sha256Schema, status: z.enum(['pending', 'running', 'completed', 'failed']), pendingIssues: issues, unitState: historicalJsonSchema.optional() }),
  source_files: base.extend({ importRunId: uuidSchema, fileName: z.string().min(1).max(4096), fileHash: sha256Schema, originalBytesBase64: sourceBytesSchema, originalText: sourceTextSchema.nullable() }),
  import_rows: base.extend({ sourceFileId: uuidSchema, rowNumber: orderSchema, rowHash: sha256Schema, originalText: longTextSchema, legacyId: shortTextSchema.nullable(), targetApplicationId: uuidSchema.nullable(), result: z.enum(['pending', 'imported', 'skipped', 'conflict', 'failed']), pendingIssues: issues, appliedTargetVersion: z.number().int().positive().nullable().optional(), resolution: historicalJsonSchema.nullable().optional(), unitResult: historicalJsonSchema.nullable().optional() }),
  audit_log: z.strictObject({ id: uuidSchema, actor: actorSchema.omit({ ownerId: true }).extend({ id: historicalLabelSchema }), source: historicalLabelSchema, occurredAt: instantSchema, entityType: historicalLabelSchema, entityId: uuidSchema, operation: historicalLabelSchema, beforeData: z.unknown(), afterData: z.unknown(), diff: z.unknown(), requestId: uuidSchema, createdAt: instantSchema }).superRefine((row, context) => {
    for (const key of ['beforeData', 'afterData', 'diff'] as const) {
      if (!(row.entityType === 'source_files' ? validSourceAudit(row[key], key === 'diff') : historicalJsonSchema.safeParse(row[key]).success)) context.addIssue({ code: 'custom', path: [key], message: 'Auditoria histórica inválida ou acima do limite.' });
    }
  }),
  opportunity_identities: base.extend({ opportunityId: uuidSchema, provider: historicalLabelSchema, tenant: historicalLabelSchema, identityKind: z.enum(['job_code', 'verified_alias']), identityValue: z.string().min(1).max(2048), verificationEvidenceId: uuidSchema.nullable() })
    .refine((v) => v.identityKind !== 'verified_alias' || v.verificationEvidenceId !== null, 'Um alias exige evidência.'),
  creation_requests: z.strictObject({
    id: uuidSchema, createdAt: instantSchema, clientId: uuidSchema, payloadHash: sha256Schema,
    entityType: z.enum(['application', 'contact', 'task', 'event', 'resume_ref', 'evidence', 'cycle']),
    resultApplicationId: uuidSchema.nullable(), resultContactId: uuidSchema.nullable(), resultTaskId: uuidSchema.nullable(), resultEventId: uuidSchema.nullable(),
    resultResumeId: uuidSchema.nullable().optional(), resultEvidenceId: uuidSchema.nullable().optional(),
    resultCycleId: uuidSchema.nullable().optional(),
  }).refine((row) => {
    const targets = { application: row.resultApplicationId, contact: row.resultContactId, task: row.resultTaskId, event: row.resultEventId, resume_ref: row.resultResumeId ?? null, evidence: row.resultEvidenceId ?? null, cycle: row.resultCycleId ?? null };
    return targets[row.entityType] !== null && Object.values(targets).filter((id) => id !== null).length === 1;
  }, 'O resultado deve corresponder ao tipo criado.'),
};
export const transferTableSchema = z.enum([
  'owner_settings', 'opportunities', 'applications', 'contacts', 'links', 'resume_refs',
  'application_resumes', 'evidence', 'events', 'tasks', 'cycles', 'batches', 'batch_members',
  'review_versions', 'import_runs', 'source_files', 'import_rows', 'audit_log', 'opportunity_identities', 'creation_requests',
]);
function envelope<T extends keyof typeof schemas>(table: T) {
  return z.strictObject({ formatVersion: z.literal(1), table: z.literal(table), data: schemas[table] });
}
export const transferEntitySchema = z.discriminatedUnion('table', [
  envelope('owner_settings'), envelope('opportunities'), envelope('applications'), envelope('contacts'),
  envelope('links'), envelope('resume_refs'), envelope('application_resumes'), envelope('evidence'),
  envelope('events'), envelope('tasks'), envelope('cycles'), envelope('batches'), envelope('batch_members'),
  envelope('review_versions'), envelope('import_runs'), envelope('source_files'), envelope('import_rows'),
  envelope('audit_log'), envelope('opportunity_identities'), envelope('creation_requests'),
]);
const orderedDigests = z.array(sha256Schema).max(100_000)
  .refine(values => values.every((value,index) => index === 0 || value > values[index-1]!));
export const MAX_DISPLAY_NUMBER = 9223372036854775807n;
const continuitySchema = z.strictObject({
  displayHighWater: z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine(value => BigInt(value) <= MAX_DISPLAY_NUMBER),
  retiredClients: orderedDigests, retiredKeys: orderedDigests, sha256: sha256Schema,
}).refine(value => value.retiredClients.length + value.retiredKeys.length <= 100_000);
export type TransferContinuity = Omit<z.infer<typeof continuitySchema>, 'sha256'>;
export const transferManifestSchema = z.strictObject({
  continuity: continuitySchema.optional(),
  formatVersion: z.literal(1), exportedAt: instantSchema, sourceOwnerId: uuidSchema,
  tables: z.array(z.strictObject({ table: transferTableSchema, count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: sha256Schema })).max(20)
    .refine((tables) => new Set(tables.map((row) => row.table)).size === tables.length, 'Cada tabela deve aparecer uma vez.'),
});
export type TransferEntity = z.infer<typeof transferEntitySchema>;
export type TransferManifest = z.infer<typeof transferManifestSchema>;
/** O snapshot completo exige inclusive campos opcionais de envelopes históricos isolados. */
export const transferDataKeys = (table: z.infer<typeof transferTableSchema>): string[] => Object.keys(schemas[table].shape);
