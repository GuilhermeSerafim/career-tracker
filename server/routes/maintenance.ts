import { z } from 'zod';
import { uuidSchema } from '../../shared/model.js';
import type { AuthenticatedActor } from '../auth';
import type { createDatabase, RequestContext } from '../database';
import { SafeError } from '../errors.js';
import { canonicalRequestHash } from '../mutation.js';

export const fixturePath = '/api/v1/maintenance/technical-fixture';
const commandSchema = z.strictObject({
  approvalId: uuidSchema, runId: uuidSchema, packageHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const replySchema = z.strictObject({
  runId: uuidSchema, requestId: uuidSchema, applicationId: uuidSchema, opportunityId: uuidSchema,
  applicationMappingId: uuidSchema,
});
const completedReply = z.union([replySchema,replySchema.extend({credentialId:uuidSchema,credentialMappingId:uuidSchema})]);

export async function removeFixture(database: ReturnType<typeof createDatabase>, actor: AuthenticatedActor,
  raw: unknown, key: string | undefined, request: RequestContext) {
  if (actor.actorKind !== 'owner') throw new SafeError('FORBIDDEN');
  const command = commandSchema.safeParse(raw);
  if (!command.success || !key || !z.uuidv4().safeParse(key).success) throw new SafeError('INVALID_INPUT');
  const hash = canonicalRequestHash({ operation: 'remove_technical_fixture', command: command.data });
  const body = await database.removeTechnicalFixture(actor, request, command.data, key, hash);
  return { status: 200, body: completedReply.parse(body) };
}
