import { z } from 'zod';
import {
  TIME_ZONE, cycleRelationSchema, dateValueSchema, eventFields, evidenceFields, instantSchema,
  labelSchema, linksSchema, longTextSchema, opportunityFields, positiveVersionSchema,
  sha256Schema, shortTextSchema, stageSchema, stackSchema, submissionStatusSchema, uuidSchema as modelUuidSchema,
} from './model.js';

export const MAX_COMMAND_BYTES = 256 * 1024;
// PostgreSQL devolve UUIDs canônicos; só entradas interativas são normalizadas.
// O schema do modelo/transferência mantém o texto histórico original.
const uuidSchema = modelUuidSchema.transform((value) => value.toLowerCase());
export const expectedVersionSchema = z.strictObject({ id: uuidSchema, expectedVersion: positiveVersionSchema });
const creationSchema = z.strictObject({ clientId: uuidSchema });
const saveTargetSchema = z.union([creationSchema, expectedVersionSchema]);
const reasonSchema = z.string().trim().min(1).max(50_000);
const newEvidenceSchema = z.strictObject({ clientId: uuidSchema, ...evidenceFields }).refine(
  (value) => [value.originalText, value.source, value.privateRef, value.localRef].some((item) => item !== null && item.trim().length > 0),
  'Descreva a evidência ou informe sua referência.',
);
export const evidenceInputSchema = z.union([z.strictObject({ id: uuidSchema }), newEvidenceSchema]);
export const agentScopeSchema = z.enum(['career:read', 'career:write', 'career:reviews', 'career:export']);
const identitySchema = z.strictObject({
  provider: labelSchema, tenant: labelSchema, kind: z.enum(['job_code', 'verified_alias']),
  value: z.string().trim().min(1).max(2048), verificationEvidence: evidenceInputSchema.nullable(),
}).refine((v) => v.kind !== 'verified_alias' || v.verificationEvidence !== null, 'Um alias exige evidência de verificação.');
export const opportunityInputSchema = z.strictObject({ ...opportunityFields, identities: z.array(identitySchema).max(50) });
const applicationDataSchema = z.strictObject({
  opportunity: opportunityInputSchema, track: shortTextSchema.nullable(), applicationInstance: labelSchema,
  submissionStatus: submissionStatusSchema, submittedDate: dateValueSchema, stage: stageSchema,
  cycleRelation: cycleRelationSchema, discoveryChannel: shortTextSchema.nullable(), submissionPlatform: shortTextSchema.nullable(),
  notes: longTextSchema.nullable(), resumeIds: z.array(uuidSchema).max(100), links: linksSchema,
});
const eventDataSchema = z.strictObject({ ...eventFields, evidence: evidenceInputSchema.nullable() });
export const taskParentsSchema = z.strictObject({ application: expectedVersionSchema.nullable(), contact: expectedVersionSchema.nullable() })
  .refine((parents) => parents.application !== null || parents.contact !== null, 'Informe ao menos um vínculo com versão.');
const applicationChangesSchema = z.strictObject({
  track: shortTextSchema.nullable().optional(), applicationInstance: labelSchema.optional(),
  stage: stageSchema.optional(), discoveryChannel: shortTextSchema.nullable().optional(),
  submissionPlatform: shortTextSchema.nullable().optional(), notes: longTextSchema.nullable().optional(),
  resumeIds: z.array(uuidSchema).max(100).optional(), links: linksSchema.optional(),
});
const opportunityPatchSchema = z.strictObject({ opportunity: expectedVersionSchema, changes: z.strictObject({
  company: opportunityFields.company.optional(), title: opportunityFields.title.optional(),
  kind: opportunityFields.kind.optional(), seniority: opportunityFields.seniority.optional(),
  modality: opportunityFields.modality.optional(), description: opportunityFields.description.optional(),
  stack: opportunityFields.stack.optional(),
}).refine((v) => Object.keys(v).length > 0, 'Informe ao menos uma alteração.') });
const affectedBatchesSchema = z.array(expectedVersionSchema).max(90).default([])
  .refine((refs) => new Set(refs.map((ref) => ref.id.toLowerCase())).size === refs.length, 'Lotes repetidos.');

const operationsSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('start_cycle'), clientId: uuidSchema, resetDate: dateValueSchema, resetMarker: shortTextSchema.nullable() }),
  z.strictObject({ operation: z.literal('save_application'), clientId: uuidSchema, data: applicationDataSchema, evidence: evidenceInputSchema.nullable() })
    .refine((c) => (c.data.submissionStatus !== 'confirmado' && c.data.applicationInstance === 'initial') || c.evidence !== null, 'Confirmação ou nova ocorrência exige evidência.'),
  z.strictObject({ operation: z.literal('create_resume_ref'), clientId: uuidSchema, data: z.strictObject({ label: shortTextSchema.nullable(), stack: stackSchema, language: shortTextSchema.nullable(), localRef: z.string().max(4096).nullable() }) }),
  z.strictObject({ operation: z.literal('confirm_submission'), application: expectedVersionSchema, submittedDate: dateValueSchema, cycleRelation: cycleRelationSchema, evidence: evidenceInputSchema }),
  z.strictObject({ operation: z.literal('update_application'), application: expectedVersionSchema, changes: applicationChangesSchema, opportunityPatch: opportunityPatchSchema.optional(), evidence: evidenceInputSchema.nullable().optional(),
    reconciliation: z.strictObject({ submittedDate: dateValueSchema, cycleRelation: cycleRelationSchema }).optional(), affectedBatches: affectedBatchesSchema })
    .refine((c) => Object.keys(c.changes).length > 0 || c.opportunityPatch !== undefined || c.reconciliation !== undefined, 'Informe ao menos uma alteração.')
    .refine((c) => (!c.changes.applicationInstance || c.changes.applicationInstance === 'initial') && !c.reconciliation || c.evidence != null, 'Uma nova ocorrência ou reconciliação exige evidência.')
    .refine((c) => c.reconciliation !== undefined || c.affectedBatches.length === 0, 'Lotes são informados apenas para reconciliação.'),
  z.strictObject({ operation: z.literal('record_event'), clientId: uuidSchema, application: expectedVersionSchema, data: eventDataSchema }),
  z.strictObject({ operation: z.literal('correct_event'), clientId: uuidSchema, application: expectedVersionSchema, eventId: uuidSchema, replacement: eventDataSchema, reason: reasonSchema, evidence: evidenceInputSchema }),
  z.strictObject({ operation: z.literal('save_task'), target: saveTargetSchema, parents: taskParentsSchema, data: z.strictObject({ title: labelSchema, dueDate: dateValueSchema }) }),
  z.strictObject({ operation: z.literal('complete_task'), task: expectedVersionSchema, parents: taskParentsSchema, completedDate: dateValueSchema }),
  z.strictObject({ operation: z.literal('save_contact'), target: saveTargetSchema, data: z.strictObject({ name: shortTextSchema.nullable(), notes: longTextSchema.nullable(), links: linksSchema }) }),
  z.strictObject({ operation: z.literal('archive_application'), application: expectedVersionSchema }),
  z.strictObject({ operation: z.literal('restore_application'), application: expectedVersionSchema }),
  z.strictObject({ operation: z.literal('resolve_duplicate'), application: expectedVersionSchema, canonicalApplication: expectedVersionSchema, affectedBatches: affectedBatchesSchema, reason: reasonSchema, evidence: evidenceInputSchema })
    .refine((value) => value.application.id !== value.canonicalApplication.id, 'A candidatura canônica deve ser outra.'),
  z.strictObject({ operation: z.literal('invalidate_submission'), application: expectedVersionSchema, affectedBatches: affectedBatchesSchema, reason: reasonSchema, evidence: evidenceInputSchema }),
  z.strictObject({ operation: z.literal('close_review'), batch: expectedVersionSchema, narrative: longTextSchema.nullable(), decisions: z.array(longTextSchema).max(100) }),
  z.strictObject({ operation: z.literal('revise_review'), batch: expectedVersionSchema, predecessorId: uuidSchema, type: z.enum(['revision', 'rectification']), narrative: longTextSchema.nullable(), decisions: z.array(longTextSchema).max(100), reason: reasonSchema, evidence: evidenceInputSchema }),
  z.strictObject({ operation: z.literal('update_settings'), settings: expectedVersionSchema, dailyGoal: z.number().int().positive().max(10_000), timezone: z.literal(TIME_ZONE) }),
  z.strictObject({ operation: z.literal('create_agent_credential'), clientId: uuidSchema, label: labelSchema, prefix: z.string().regex(/^[a-zA-Z0-9_-]{4,32}$/), tokenHash: sha256Schema, scopes: z.array(agentScopeSchema).min(1).max(4).refine((v) => new Set(v).size === v.length), expiresAt: instantSchema.nullable() }),
  z.strictObject({ operation: z.literal('revoke_agent_credential'), credential: expectedVersionSchema }),
]);

/** O limite HTTP antes do parse será aplicado no transporte; este protege os consumidores diretos. */
export const commandSchema = z.custom<z.input<typeof operationsSchema>>(
  (command) => {
    try { return new TextEncoder().encode(JSON.stringify(command)).byteLength <= MAX_COMMAND_BYTES; }
    catch { return false; }
  },
  'O comando excede o limite de 256 KiB.',
).pipe(operationsSchema);
export type Command = z.infer<typeof commandSchema>;
export type Operation = Command['operation'];
export type AgentScope = z.infer<typeof agentScopeSchema>;
