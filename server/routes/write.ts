import { commandSchema } from '../../shared/commands.js';
import { z } from 'zod';
import { positiveVersionSchema, uuidSchema } from '../../shared/model.js';
import { createMutation } from '../mutation.js';
import type { createDatabase, RequestContext } from '../database';
import type { AuthenticatedActor } from '../auth';
import { SafeError } from '../errors.js';
import { createApplicationService } from '../services/applications.js';
import { createActivityService } from '../services/activity.js';
import { createReviewService } from '../services/reviews.js';
import { createCredentialService } from '../services/credentials.js';

export function createWriteRoute(database: ReturnType<typeof createDatabase>) {
  const applications = createApplicationService(database);
  const activity = createActivityService(database);
  const reviews = createReviewService(database);
  const credentials = createCredentialService(database);
  const settings = createMutation(database, {
    operation: 'settings_command',
    commandSchema,
    responseSchema: z.strictObject({
      settings: z.strictObject({
        id: uuidSchema,
        version: positiveVersionSchema,
        dailyGoal: z.number().int().positive(),
        timezone: z.literal('America/Sao_Paulo'),
      }),
    }),
    async execute(context, command) {
      if (command.operation !== 'update_settings') throw new SafeError('INVALID_INPUT');
      await context.lockAggregates([{ table: 'owner_settings', id: command.settings.id }]);
      const row = (
        await context.transaction.query<{ version: number }>(
          'SELECT version FROM career.owner_settings WHERE owner_id=$1 AND id=$2',
          [context.ownerId, command.settings.id],
        )
      ).rows[0]!;
      if (row.version !== command.settings.expectedVersion)
        throw new SafeError('CONFLICT', {
          details: { currentVersion: row.version, changedFields: ['daily_goal'] },
        });
      const updated = (
        await context.transaction.query<{
          id: string;
          version: number;
          dailyGoal: number;
          timezone: 'America/Sao_Paulo';
        }>(
          `UPDATE career.owner_settings SET daily_goal=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING id,version,daily_goal AS "dailyGoal",timezone`,
          [context.ownerId, command.settings.id, command.dailyGoal],
        )
      ).rows[0];
      if (!updated) throw new SafeError('DATABASE_UNAVAILABLE');
      return { status: 200, body: { settings: updated } };
    },
  });
  return (
    actor: AuthenticatedActor,
    raw: unknown,
    idempotencyKey: string | undefined,
    context: RequestContext,
  ) => {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) throw new SafeError('INVALID_INPUT');
    const command = parsed.data;
    if (command.operation === 'create_agent_credential' || command.operation === 'revoke_agent_credential') return credentials(actor, { command, idempotencyKey }, context);
    if (command.operation === 'update_settings')
      return settings(actor, { command, idempotencyKey }, context);
    const service = ['start_cycle', 'close_review', 'revise_review'].includes(command.operation)
      ? reviews
      : ['record_event', 'correct_event', 'save_contact', 'save_task', 'complete_task'].includes(
            command.operation,
          )
        ? activity
        : applications;
    return service(actor, { command, idempotencyKey }, context);
  };
}
