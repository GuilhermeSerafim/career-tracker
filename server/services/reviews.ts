import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { commandSchema, type Command } from '../../shared/commands.js';
import { buildReviewSnapshot, REVIEW_CALCULATION_VERSION } from '../../domain/cycles.js';
import { uuidSchema, positiveVersionSchema } from '../../shared/model.js';
import { canonicalRequestHash, createMutation, type MutationContext } from '../mutation.js';
import type { createDatabase } from '../database';
import { SafeError } from '../errors.js';
import { getReview, loadReviewProjection, reviewArea } from '../repositories/reviews.js';

const resultSchema = z.strictObject({ cycleId: uuidSchema.nullable(), reviewId: uuidSchema.nullable(), versionNumber: positiveVersionSchema.nullable(), batchVersion: positiveVersionSchema.nullable() });
async function evidence(context: MutationContext, input: Extract<Command, { operation: 'revise_review' }>['evidence']) {
  if ('id' in input) {
    if (!(await context.transaction.query('SELECT id FROM career.evidence WHERE owner_id=$1 AND id=$2', [context.ownerId, input.id])).rowCount) throw new SafeError('NOT_FOUND');
    return input.id;
  }
  const hash = canonicalRequestHash(input);
  const old = (await context.transaction.query<{ payload_hash: string; result_evidence_id: string }>("SELECT payload_hash,result_evidence_id FROM career.creation_requests WHERE owner_id=$1 AND entity_type='evidence' AND client_id=$2", [context.ownerId, input.clientId])).rows[0];
  if (old) { if (old.payload_hash !== hash) throw new SafeError('IDEMPOTENCY_CONFLICT'); return old.result_evidence_id; }
  const id = randomUUID();
  await context.transaction.query('INSERT INTO career.evidence(id,owner_id,kind,original_text,source,occurred_date,private_ref,local_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, context.ownerId, input.kind, input.originalText, input.source, input.occurredDate, input.privateRef, input.localRef]);
  await context.transaction.query("INSERT INTO career.creation_requests(owner_id,entity_type,client_id,payload_hash,result_evidence_id) VALUES($1,'evidence',$2,$3,$4)", [context.ownerId, input.clientId, hash, id]);
  return id;
}

export function createReviewService(database: ReturnType<typeof createDatabase>) {
  const mutate = createMutation(database, { operation: 'review_command', commandSchema, responseSchema: resultSchema,
    async execute(context, command) {
      if (command.operation === 'start_cycle') {
        if (context.actorKind !== 'owner') throw new SafeError('FORBIDDEN');
        await context.transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`career.application-identity:${context.ownerId}`]);
        const hash = canonicalRequestHash(command);
        const prior = (await context.transaction.query<{ payload_hash: string; result_cycle_id: string }>("SELECT payload_hash,result_cycle_id FROM career.creation_requests WHERE owner_id=$1 AND entity_type='cycle' AND client_id=$2", [context.ownerId, command.clientId])).rows[0];
        if (prior) {
          if (prior.payload_hash !== hash) throw new SafeError('IDEMPOTENCY_CONFLICT');
          return { status: 200, body: { cycleId: prior.result_cycle_id, reviewId: null, versionNumber: null, batchVersion: null } };
        }
        if ((await context.transaction.query('SELECT id FROM career.cycles WHERE owner_id=$1', [context.ownerId])).rowCount) throw new SafeError('CYCLE_CONFIGURATION');
        const id = randomUUID();
        await context.transaction.query('INSERT INTO career.cycles(id,owner_id,reset_date,reset_marker,is_current,next_order) SELECT $1,$2,$3,$4,true,coalesce(max(cycle_order),0)+1 FROM career.applications WHERE owner_id=$2', [id, context.ownerId, command.resetDate, command.resetMarker]);
        await context.transaction.query("INSERT INTO career.creation_requests(owner_id,entity_type,client_id,payload_hash,result_cycle_id) VALUES($1,'cycle',$2,$3,$4)", [context.ownerId, command.clientId, hash, id]);
        return { status: 201, body: { cycleId: id, reviewId: null, versionNumber: null, batchVersion: null } };
      }
      if (command.operation !== 'close_review' && command.operation !== 'revise_review') throw new SafeError('INVALID_INPUT');
      // Congelar o pai primeiro. Nenhum lock de candidatura/ciclo depois deste ponto.
      await context.lockAggregates([{ table: 'batches', id: command.batch.id }]);
      const batch = (await context.transaction.query<{ version: number; status: string; target: number; rectification_pending: boolean }>('SELECT version,status,target,rectification_pending FROM career.batches WHERE owner_id=$1 AND id=$2', [context.ownerId, command.batch.id])).rows[0]!;
      if (batch.version !== command.batch.expectedVersion) throw new SafeError('CONFLICT');
      const previous = (await context.transaction.query('SELECT * FROM career.review_versions WHERE owner_id=$1 AND batch_id=$2 ORDER BY version_number DESC LIMIT 1', [context.ownerId, command.batch.id])).rows[0];
      if (command.operation === 'close_review' ? batch.status !== 'pending' || Boolean(previous) : batch.status !== 'closed' || !previous || previous.id !== command.predecessorId) throw new SafeError('CONFLICT');
      const projection = await loadReviewProjection(context.transaction, context.ownerId, command.batch.id);
      const population = previous ? previous.population_ids as string[] : projection.populationIds;
      // Só a retificação explícita reavalia todos os IDs capturados, inclusive excluídos no fechamento.
      const eligibilityPopulation = command.operation === 'revise_review' && command.type === 'rectification' ? population : projection.countedPopulationIds;
      const snapshot = command.operation === 'revise_review' && command.type === 'revision' ? previous!.snapshot : buildReviewSnapshot(projection.rows, projection.events, population, projection.asOf, eligibilityPopulation);
      if (command.operation === 'close_review' || command.type === 'rectification') {
        const captured = new Set(snapshot.eventIds as string[]);
        const sent = new Set((snapshot.applications as { resumeIds: string[] }[]).flatMap((row) => row.resumeIds));
        snapshot.eventEvidence = projection.eventEvidence.filter((item) => captured.has(item.eventId));
        snapshot.resumeRefs = projection.resumeRefs.filter((resume) => sent.has(resume.id));
      }
      if (command.operation === 'close_review' && snapshot.eligiblePopulationIds.length !== batch.target) throw new SafeError('CONFLICT');
      const id = randomUUID(); const number = previous ? Number(previous.version_number) + 1 : 1;
      const evidenceId = command.operation === 'revise_review' ? await evidence(context, command.evidence) : null;
      const calculationVersion = command.operation === 'revise_review' && command.type === 'revision' ? previous!.calculation_version : REVIEW_CALCULATION_VERSION;
      const eventIds = command.operation === 'revise_review' && command.type === 'revision' ? previous!.event_ids : snapshot.eventIds;
      const closedAt = previous ? previous.closed_at : projection.asOf;
      await context.transaction.query(`INSERT INTO career.review_versions(id,owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids,narrative,decisions,predecessor_id,calculation_version,closed_at,reason,evidence_id,original_markdown,import_provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [id, context.ownerId, command.batch.id, number, command.operation === 'close_review' ? 'original' : command.type, snapshot, population, eventIds, command.narrative, command.decisions, previous?.id ?? null, calculationVersion, closedAt, command.operation === 'revise_review' ? command.reason : null, evidenceId, previous?.original_markdown ?? null, previous?.import_provenance ?? null]);
      await context.transaction.query("UPDATE career.batches SET status='closed',rectification_pending=CASE WHEN $3 THEN false ELSE rectification_pending END,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [context.ownerId, command.batch.id, command.operation === 'revise_review' && command.type === 'rectification']);
      return { status: 201, body: { cycleId: null, reviewId: id, versionNumber: number, batchVersion: batch.version + 1 } };
    },
  });
  return mutate;
}

export function createReviewReadService(database: ReturnType<typeof createDatabase>) {
  return (actor: Parameters<typeof database.transaction>[0], batchId: string, versionNumber: number | null = null) => database.transaction(actor, (transaction) => getReview(transaction, actor.ownerId, uuidSchema.parse(batchId), versionNumber));
}

export function createReviewAreaService(database: ReturnType<typeof createDatabase>) {
  return (actor: Parameters<typeof database.transaction>[0]) => database.transaction(actor, (transaction) => reviewArea(transaction, actor.ownerId));
}
