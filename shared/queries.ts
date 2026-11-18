import { z } from 'zod';
import { instantSchema, labelSchema, periodSchema, shortTextSchema, stageSchema, submissionStatusSchema, uuidSchema } from './model.js';

const values = z.array(labelSchema).max(50);
export const applicationFiltersSchema = z.strictObject({
  company: values.optional(), title: values.optional(), stack: values.optional(), seniority: values.optional(),
  modality: values.optional(), channel: values.optional(), platform: values.optional(),
  status: z.array(submissionStatusSchema).max(3).optional(), stage: z.array(stageSchema).max(10).optional(),
  batch: z.array(uuidSchema).max(50).optional(), archived: z.enum(['exclude', 'include', 'only']).optional(),
});
export const pageSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  after: z.strictObject({ createdAt: instantSchema, id: uuidSchema }).nullable(),
});
export const populationSchema = z.enum(['confirmed', 'saved', 'unknown', 'all']);
export const dimensionSchema = z.enum(['company', 'title', 'stack', 'seniority', 'modality', 'channel', 'platform', 'status', 'stage', 'batch']);
export const querySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list_applications'), view: z.enum(['confirmed', 'saved', 'unknown']), search: shortTextSchema, filters: applicationFiltersSchema, page: pageSchema }),
  z.strictObject({ operation: z.literal('get_application'), id: uuidSchema }),
  z.strictObject({ operation: z.literal('metrics'), period: periodSchema, population: populationSchema, dimension: dimensionSchema, filters: applicationFiltersSchema.optional() }),
  z.strictObject({ operation: z.literal('list_tasks'), status: z.enum(['pending', 'completed', 'cancelled', 'all']), applicationId: uuidSchema.nullable(), contactId: uuidSchema.nullable(), page: pageSchema }),
  z.strictObject({ operation: z.literal('get_review'), batchId: uuidSchema, versionNumber: z.number().int().positive().nullable() }),
  z.strictObject({ operation: z.literal('list_contacts'), search: shortTextSchema, page: pageSchema }),
]);
export type Query = z.infer<typeof querySchema>;
export type ApplicationFilters = z.infer<typeof applicationFiltersSchema>;
