import { z } from 'zod';
import { dateValueSchema, sha256Schema, submissionStatusSchema } from './model.js';

export const MAX_CSV_UPLOAD_BYTES = 1_048_576;
export const MAX_CSV_UPLOAD_ROWS = 500;
export const csvFileNameSchema = z.string().max(255).regex(/^[^./\\:][^/\\:]*\.csv$/iu)
  .refine((name) => Array.from(name).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
export const csvUploadSchema = z.strictObject({
  fileName: csvFileNameSchema,
  bytesBase64: z.string().min(1).max(Math.ceil(MAX_CSV_UPLOAD_BYTES / 3) * 4),
});
export const csvConfirmationSchema = csvUploadSchema.extend({ confirmation: sha256Schema });

const count = z.number().int().min(0).max(MAX_CSV_UPLOAD_ROWS);
export const csvPreviewSchema = z.strictObject({
  writes: z.literal(false),
  blocked: z.boolean(),
  confirmation: sha256Schema.nullable(),
  totals: z.strictObject({ rows: count, eligible: count, unchanged: count, review: count }),
  issues: z.array(z.strictObject({
    code: z.string(), row: z.number().int().positive().nullable(), column: z.string().nullable(),
  })),
  rows: z.array(z.strictObject({
    number: z.number().int().min(2), legacyId: z.string(), company: z.string(), title: z.string(),
    submittedDate: dateValueSchema, submissionStatus: submissionStatusSchema.nullable(),
    cycleOrder: z.number().int().positive().nullable(),
    missing: z.array(z.string()), issues: z.array(z.string()),
    status: z.enum(['eligible', 'unchanged', 'duplicate', 'conflict', 'blocked']),
  })).max(MAX_CSV_UPLOAD_ROWS),
});

export const csvReceiptSchema = z.strictObject({
  runId: z.uuid(), imported: count, unchanged: count, review: count,
});

export type CsvUpload = z.infer<typeof csvUploadSchema>;
export type CsvPreview = z.infer<typeof csvPreviewSchema>;
export type CsvReceipt = z.infer<typeof csvReceiptSchema>;
