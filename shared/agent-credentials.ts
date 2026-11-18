import { z } from 'zod';
import { agentScopeSchema } from './commands.js';
import { instantSchema, positiveVersionSchema, uuidSchema } from './model.js';

export const credentialMetadataSchema = z.strictObject({ id: uuidSchema, version: positiveVersionSchema, label: z.string(), prefix: z.string(), scopes: z.array(agentScopeSchema), expiresAt: instantSchema.nullable(), revokedAt: instantSchema.nullable(), createdAt: instantSchema });
export const credentialResultSchema = z.strictObject({ credential: credentialMetadataSchema });
export const credentialPageSchema = z.strictObject({ items: z.array(credentialMetadataSchema).max(100), nextCursor: z.string().nullable() });
export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>;
