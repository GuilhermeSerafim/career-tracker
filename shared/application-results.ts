import { z } from 'zod';
import { applicationMetricsRowSchema, shortTextSchema, stackSchema, uuidSchema, versionedSchema, opportunityFields } from './model.js';

export const resumeRefSchema = versionedSchema.extend({ label: shortTextSchema.nullable(), stack: stackSchema, language: shortTextSchema.nullable(), localRef: z.string().max(4096).nullable() });
export const applicationProjectionSchema = applicationMetricsRowSchema.extend({
  opportunity: versionedSchema.extend(opportunityFields), track: shortTextSchema.nullable(), applicationInstance: z.string(), notes: z.string().nullable(),
  historyApplicationIds: z.array(uuidSchema), eventIds: z.array(uuidSchema),
});
export const applicationResultSchema = z.strictObject({
  application: applicationProjectionSchema.nullable(), resumeRef: resumeRefSchema.nullable(),
  existing: z.boolean(), warnings: z.array(z.strictObject({ applicationId: uuidSchema, reason: z.enum(['same_company_title', 'unresolved_identity']) })),
  eligibilityChanges: z.array(z.strictObject({ applicationId: uuidSchema, before: z.boolean(), after: z.boolean() })),
  affectedBatches: z.array(versionedSchema.extend({ rectificationPending: z.boolean() })),
  allocationPending: z.boolean(),
});
export type ApplicationResult = z.infer<typeof applicationResultSchema>;
