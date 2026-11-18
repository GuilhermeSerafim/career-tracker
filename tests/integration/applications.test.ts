import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticatedAgentFixture } from '../helpers/agent';
import { authenticateBearer, type AuthenticatedActor } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase } from '../../server/database';
import type { AuthenticatedTransaction, RequestContext } from '../../server/database';
import { createReviewService } from '../../server/services/reviews';
import { createApplicationService } from '../../server/services/applications';
import { provisionOwner } from '../../scripts/provision-owner';
import { connectTestDatabase } from '../helpers/database';
import { day, unknownDate } from '../fixtures/career';
import { applicationResultSchema } from '../../shared/application-results';
import { normalizeTrack } from '../../domain/identity';



const opportunity = () => ({ company: 'Empresa fictícia', title: 'Engenharia', platform: 'portal', tenant: randomUUID() as string | null, jobCode: '42', jobKey: null, kind: 'vaga' as const, seniority: null, modality: null, description: null, stack: [], identities: [] as { provider: string; tenant: string; kind: 'job_code' | 'verified_alias'; value: string; verificationEvidence: ReturnType<typeof evidence> | null }[] });
const evidence = () => ({ clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Relato fictício de envio.', source: null, occurredDate: unknownDate, privateRef: null, localRef: null });
const save = () => ({ operation: 'save_application', clientId: randomUUID(), data: { opportunity: opportunity(), track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: unknownDate, stage: 'desconhecida', cycleRelation: 'unknown', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [] as string[], links: [] }, evidence: evidence() });

describe('candidaturas via login restrito em duas conexões', () => {
  const owner = randomUUID(); let db: pg.Client;
  let first: ReturnType<typeof createDatabase>; let second: ReturnType<typeof createDatabase>;
  let actor: Awaited<ReturnType<typeof authenticateBearer>>; let actorAgain: AuthenticatedActor;
  let service: ReturnType<typeof createApplicationService>;
  beforeAll(async () => {
    db = await connectTestDatabase();
    const password = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword: password, restorePassword: randomBytes(32).toString('base64url') });
    const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!); url.username = 'career_api'; url.password = password;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', DATABASE_POOL_MAX: '1', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    first = createDatabase(config); second = createDatabase(config); service = createApplicationService(first);
    const auth = () => authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
    actor = await auth();
    actorAgain = await authenticatedAgentFixture(first, config, actor);
    await createReviewService(first)(actor, { idempotencyKey: randomUUID(), command: { operation: 'start_cycle', clientId: randomUUID(), resetDate: unknownDate, resetMarker: null } });
  });
  afterAll(async () => {
    await first?.close(); await second?.close();
    if (db) {
      // Limpeza de fixtures fechadas pelo administrador do banco dedicado, nunca pelo runtime.
      await db.query('BEGIN'); await db.query("SET LOCAL session_replication_role='replica'");
      for (const table of ['agent_credentials', 'mutation_keys', 'creation_requests', 'review_versions', 'batch_members', 'batches', 'cycles', 'application_resumes', 'links', 'events', 'evidence', 'resume_refs', 'applications', 'opportunity_identities', 'opportunities', 'owner_settings', 'audit_log', 'maintenance_state', 'owner_config']) await db.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
      await db.query('COMMIT');
      await db.end();
    }
  });
  const call = (command: unknown, api = service, who: AuthenticatedActor = actor, key = randomUUID()) => api(who, { idempotencyKey: key, command });
  const application = async (command: unknown, api = service) => {
    const result = applicationResultSchema.parse((await call(command, api)).body);
    expect(result.application).not.toBeNull(); return result.application!;
  };
  function pauseAfterDiscovery() {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; }); let paused = false;
    const intercepted = { ...first, async transaction<T>(who: typeof actor, work: (tx: AuthenticatedTransaction) => Promise<T>, context?: RequestContext) {
      return first.transaction(who, async (tx) => work({ ...tx, query: async <Row extends pg.QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await tx.query<Row>(sql, values);
        if (!paused && sql.startsWith('SELECT DISTINCT m.')) { paused = true; entered(); await waiting; }
        return result;
      } }), context);
    } };
    return { service: createApplicationService(intercepted), started, release };
  }
  async function batchFixture(ids: string[], closed = false) {
    const cycle = (await db.query('INSERT INTO career.cycles(owner_id) VALUES($1) RETURNING id', [owner])).rows[0].id as string;
    const batch = (await db.query('INSERT INTO career.batches(owner_id,cycle_id,batch_number) VALUES($1,$2,1) RETURNING id', [owner, cycle])).rows[0].id as string;
    for (let i = 0; i < ids.length; i++) await db.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,$4)', [owner, batch, ids[i], i + 1]);
    if (closed) {
      await db.query("INSERT INTO career.review_versions(owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids) VALUES($1,$2,1,'original',$3,$4,'{}')", [owner, batch, { fixture: 'snapshot congelado' }, ids]);
      await db.query("UPDATE career.batches SET status='closed' WHERE id=$1", [batch]);
    }
    return { cycle, batch };
  }
  it('grava confirmação única com data desconhecida e evidência atômica', async () => {
    const command = save(); const reply = await call(command);
    expect(reply.body).toMatchObject({ application: { displayId: expect.stringMatching(/^N\d{6,}$/), submissionStatus: 'confirmado', submittedDate: unknownDate, cycleOrder: null } });
    expect((await db.query('SELECT count(*)::int AS n FROM career.events WHERE owner_id=$1 AND kind=\'envio_confirmado\'', [owner])).rows[0].n).toBe(1);
  });
  it('serializa criação forte entre conexões e reutiliza clientId sem sobrescrever', async () => {
    const command = save();
    const replies = await Promise.all([call(command), call({ ...command, clientId: randomUUID(), evidence: evidence() }, createApplicationService(second), actorAgain)]);
    const a = applicationResultSchema.parse(replies[0]!.body); const b = applicationResultSchema.parse(replies[1]!.body);
    expect(a.application?.id).toBe(b.application?.id);
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    const replay = applicationResultSchema.parse((await call(command, createApplicationService(second), actorAgain)).body);
    expect(replay.application?.id).toBe(a.application?.id);
    await expect(call({ ...command, data: { ...command.data, notes: 'Mudou' } })).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT count(*)::int AS n FROM career.applications WHERE opportunity_id=$1', [a.application?.opportunity.id])).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM career.events WHERE application_id=$1 AND kind='envio_confirmado'", [a.application?.id])).rows[0].n).toBe(1);
  });
  it('preserva trilhas e ocorrências deliberadas, distingue tenant/código e caixa', async () => {
    const command = save(); const a = await application(command);
    const create = (track: string | null, applicationInstance = 'initial') => ({ ...command, clientId: randomUUID(), evidence: evidence(), data: { ...command.data, track, applicationInstance } });
    expect((await application(create(' \t'))).id).toBe(a.id);
    const tracks = await Promise.all(['AI Engineer', 'AI Builder', 'ai engineer'].map((track) => application(create(track))));
    expect(new Set(tracks.map((app) => app.id)).size).toBe(3);
    const later = await application(create(null, 'second')); expect(later.id).not.toBe(a.id);
    await expect(call({ ...create(null, 'third'), evidence: null })).rejects.toMatchObject({ status: 400 });
    for (const changes of [{ tenant: 'outro' }, { jobCode: '43' }]) expect((await application({ ...command, clientId: randomUUID(), data: { ...command.data, opportunity: { ...command.data.opportunity, ...changes } } })).opportunity.id).not.toBe(a.opportunity.id);
    const archived = await application({ operation: 'archive_application', application: { id: a.id, expectedVersion: 1 } });
    expect(archived).toMatchObject({ submissionStatus: 'confirmado', countingEligible: true, archivedAt: expect.any(String) });
    expect((await application(create(null))).id).toBe(a.id);
    const restored = await application({ operation: 'restore_application', application: { id: a.id, expectedVersion: archived.version } });
    expect(restored.archivedAt).toBeNull(); expect(restored.displayId).toBe(a.displayId);
  });
  it('não confunde empresa/cargo nem tenant ausente com identidade resolvida', async () => {
    const command = save(); command.data.opportunity.tenant = null;
    const a = await application(command);
    const reply = applicationResultSchema.parse((await call({ ...command, clientId: randomUUID(), evidence: evidence() })).body);
    expect(reply.application?.id).not.toBe(a.id);
    expect(reply.warnings).toContainEqual({ applicationId: a.id, reason: 'same_company_title' });
  });
  it('mantém igualdade real PostgreSQL/TypeScript para espaços e letras comuns', async () => {
    const command = save(); command.data.submissionStatus = 'nao_confirmado';
    const app = await application(command);
    for (const track of [null, ' \t', '\t AI  Engineer\r\n\u00a0', 'tuner natural', 'AI\u2003Engineer', 'ai engineer', '\f\vCase\tPreserved\u00a0']) {
      await db.query('BEGIN');
      try {
        const row = (await db.query('UPDATE career.applications SET track=$2 WHERE id=$1 RETURNING normalized_track', [app.id, track])).rows[0];
        expect(row.normalized_track).toBe(normalizeTrack(track));
      } finally { await db.query('ROLLBACK'); }
    }
  });
  it('nova evidência não cria outro envio e etapa não confirma candidatura', async () => {
    const command = save(); command.data.submissionStatus = 'nao_confirmado'; command.data.stage = 'entrevista';
    const a = await application(command); expect(a.submissionStatus).toBe('nao_confirmado');
    const confirm = { operation: 'confirm_submission', application: { id: a.id, expectedVersion: a.version }, submittedDate: unknownDate, cycleRelation: 'unknown', evidence: evidence() };
    const b = await application(confirm);
    const c = await application({ ...confirm, application: { id: a.id, expectedVersion: b.version }, evidence: evidence() });
    expect(c.submittedDate).toEqual(unknownDate); expect(c.cycleOrder).toBeNull();
    expect((await db.query("SELECT count(*)::int AS n FROM career.events WHERE application_id=$1 AND kind='envio_confirmado'", [a.id])).rows[0].n).toBe(1);
    expect(c.eventIds.length).toBeGreaterThan(b.eventIds.length);
    await expect(call(confirm)).rejects.toMatchObject({ status: 409 });
    await expect(call({ ...confirm, application: { id: randomUUID(), expectedVersion: 1 } })).rejects.toMatchObject({ status: 404 });
  });
  it('cria referência de CV, associa e reverte seleção preservando associação', async () => {
    const command = { operation: 'create_resume_ref', clientId: randomUUID(), data: { label: 'CV fictício', stack: ['TS'], language: 'pt-BR', localRef: 'arquivo local, sem leitura' } };
    const resume = applicationResultSchema.parse((await call(command)).body).resumeRef!;
    expect(applicationResultSchema.parse((await call(command, createApplicationService(second), actorAgain)).body).resumeRef?.id).toBe(resume.id);
    await expect(call({ ...command, data: { ...command.data, label: 'Diferente' } })).rejects.toMatchObject({ status: 409 });
    const create = save(); create.data.resumeIds = [resume.id]; const a = await application(create);
    expect(a.resumeIds).toEqual([resume.id]);
    const before = (await db.query('SELECT id,created_at FROM career.application_resumes WHERE application_id=$1', [a.id])).rows[0];
    const b = await application({ operation: 'update_application', application: { id: a.id, expectedVersion: 1 }, changes: { resumeIds: [] } });
    expect(b.resumeIds).toEqual([]);
    const c = await application({ operation: 'update_application', application: { id: a.id, expectedVersion: b.version }, changes: { resumeIds: [resume.id] } });
    expect(c.resumeIds).toEqual([resume.id]);
    expect((await db.query('SELECT id,created_at FROM career.application_resumes WHERE application_id=$1', [a.id])).rows[0]).toEqual(before);
  });
  it('exige versão da oportunidade compartilhada e evidência na mudança de ocorrência', async () => {
    const create = save(); const a = await application(create);
    const b = await application({ ...create, clientId: randomUUID(), data: { ...create.data, track: 'AI Builder' } });
    const update = { operation: 'update_application', application: { id: a.id, expectedVersion: 1 }, changes: {}, opportunityPatch: { opportunity: { id: a.opportunity.id, expectedVersion: 1 }, changes: { title: 'Cargo corrigido' } } };
    const updated = await application(update); expect(updated.opportunity.version).toBe(2); expect(updated.version).toBe(2);
    await expect(call({ ...update, application: { id: b.id, expectedVersion: 1 } })).rejects.toMatchObject({ status: 409 });
    const later = { operation: 'update_application', application: { id: a.id, expectedVersion: 2 }, changes: { applicationInstance: 'second' } };
    await expect(call(later)).rejects.toMatchObject({ status: 400 });
    expect((await application({ ...later, evidence: evidence() })).applicationInstance).toBe('second');
  });
  it('reverte oportunidade, evidência, auditoria e mapeamento após falha de vínculo', async () => {
    const command = save(); command.data.resumeIds = [randomUUID()];
    const before = (await db.query('SELECT (SELECT count(*) FROM career.opportunities WHERE owner_id=$1)::int AS opportunities,(SELECT count(*) FROM career.evidence WHERE owner_id=$1)::int AS evidence,(SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audit', [owner])).rows[0];
    await expect(call(command)).rejects.toMatchObject({ status: 404 });
    expect((await db.query('SELECT (SELECT count(*) FROM career.opportunities WHERE owner_id=$1)::int AS opportunities,(SELECT count(*) FROM career.evidence WHERE owner_id=$1)::int AS evidence,(SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audit', [owner])).rows[0]).toEqual(before);
    expect((await db.query('SELECT id FROM career.creation_requests WHERE client_id=$1', [command.clientId])).rowCount).toBe(0);
  });
  it('invalida contagem com evidência sem apagar confirmação e congela lote fechado', async () => {
    const app = await application(save()); const { batch } = await batchFixture([app.id], true);
    const before = (await db.query('SELECT * FROM career.batch_members WHERE batch_id=$1', [batch])).rows;
    const snapshot = (await db.query('SELECT * FROM career.review_versions WHERE batch_id=$1', [batch])).rows;
    const command = { operation: 'invalidate_submission', application: { id: app.id, expectedVersion: 1 }, reason: 'Confirmação registrada para processo incorreto.', evidence: evidence(), affectedBatches: [{ id: batch, expectedVersion: 1 }] };
    for (const { affectedBatches, status } of [
      { affectedBatches: [], status: 409 },
      { affectedBatches: [{ id: randomUUID(), expectedVersion: 1 }], status: 409 },
      { affectedBatches: [{ id: batch, expectedVersion: 2 }], status: 409 },
      { affectedBatches: [{ id: batch, expectedVersion: 1 }, { id: batch, expectedVersion: 1 }], status: 400 },
    ]) await expect(call({ ...command, affectedBatches })).rejects.toMatchObject({ status });
    const result = applicationResultSchema.parse((await call(command)).body);
    expect(result.application).toMatchObject({ id: app.id, displayId: app.displayId, submissionStatus: 'confirmado', countingEligible: false });
    expect(result.eligibilityChanges).toEqual([{ applicationId: app.id, before: true, after: false }]);
    expect(result.affectedBatches).toEqual([{ id: batch, version: 2, rectificationPending: true }]);
    expect((await db.query('SELECT * FROM career.batch_members WHERE batch_id=$1', [batch])).rows).toEqual(before);
    expect((await db.query('SELECT * FROM career.review_versions WHERE batch_id=$1', [batch])).rows).toEqual(snapshot);
  });
  it('resolve duplicata preservando aliases, IDs, histórico e ordem do lote aberto', async () => {
    const sourceCommand = save(); const source = await application(sourceCommand); const target = await application(save());
    const { batch } = await batchFixture([source.id, target.id]);
    const command = { operation: 'resolve_duplicate', application: { id: source.id, expectedVersion: 1 }, canonicalApplication: { id: target.id, expectedVersion: 1 }, reason: 'Dois registros da mesma candidatura.', evidence: evidence(), affectedBatches: [{ id: batch, expectedVersion: 1 }] };
    const result = applicationResultSchema.parse((await call(command)).body);
    expect(result.application?.id).toBe(target.id);
    expect(result.application?.historyApplicationIds.sort()).toEqual([source.id, target.id].sort());
    expect(result.application?.eventIds).toEqual(expect.arrayContaining(source.eventIds.concat(target.eventIds)));
    expect(result.affectedBatches).toEqual([{ id: batch, version: 2, rectificationPending: false }]);
    expect((await db.query('SELECT application_id,captured_order,eligible FROM career.batch_members WHERE batch_id=$1 ORDER BY captured_order', [batch])).rows).toEqual([{ application_id: source.id, captured_order: '1', eligible: false }, { application_id: target.id, captured_order: '2', eligible: true }]);
    expect((await application(sourceCommand)).id).toBe(target.id);
    expect((await application({ ...sourceCommand, clientId: randomUUID(), evidence: evidence() })).id).toBe(target.id);
    await expect(call({ ...command, application: { id: target.id, expectedVersion: 2 }, canonicalApplication: { id: source.id, expectedVersion: 2 }, affectedBatches: [{ id: batch, expectedVersion: 2 }] })).rejects.toMatchObject({ status: 409 });
  });
  it('recusa resolução entre trilhas diferentes e permite alias alternativo verificado', async () => {
    const command = save();
    command.data.opportunity.identities = [{ provider: 'portal', tenant: command.data.opportunity.tenant!, kind: 'verified_alias', value: 'alias42', verificationEvidence: evidence() }];
    const a = await application(command);
    const alias = save(); alias.data.opportunity.platform = 'outro'; alias.data.opportunity.identities = command.data.opportunity.identities;
    expect((await application(alias)).id).toBe(a.id);
    const b = await application({ ...command, clientId: randomUUID(), data: { ...command.data, track: 'AI Builder' } });
    await expect(call({ operation: 'resolve_duplicate', application: { id: a.id, expectedVersion: 1 }, canonicalApplication: { id: b.id, expectedVersion: 1 }, reason: 'Não confundir trilhas', evidence: evidence() })).rejects.toMatchObject({ status: 409 });
  });
  it('reutiliza evidência original entre registros e recusa alteração do mesmo clientId', async () => {
    const shared = evidence(); const a = await application({ ...save(), evidence: shared });
    const b = await application({ ...save(), evidence: shared });
    const refs = (await db.query('SELECT evidence_id FROM career.events WHERE application_id=ANY($1::uuid[])', [[a.id, b.id]])).rows;
    expect(new Set(refs.map((r) => r.evidence_id)).size).toBe(1);
    await expect(call({ ...save(), evidence: { ...shared, originalText: 'Mudou' } })).rejects.toMatchObject({ status: 409 });
  });
  it('detecta associação nova no mesmo lote entre descoberta e locks sem gravação parcial', async () => {
    const a = await application(save()); const b = await application(save()); const { batch } = await batchFixture([a.id]);
    const gate = pauseAfterDiscovery();
    const pending = call({ operation: 'resolve_duplicate', application: { id: a.id, expectedVersion: 1 }, canonicalApplication: { id: b.id, expectedVersion: 1 }, affectedBatches: [{ id: batch, expectedVersion: 1 }], reason: 'Corrigir', evidence: evidence() }, gate.service);
    const assertion = expect(pending).rejects.toMatchObject({ status: 409 });
    await gate.started;
    try {
      await second.transaction(actor, async (tx) => {
        await tx.query('SELECT id FROM career.applications WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner, b.id]);
        await tx.query('SELECT id FROM career.batches WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner, batch]);
        await tx.query("UPDATE career.applications SET cycle_relation='after_reset' WHERE id=$1", [b.id]);
        await tx.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,2)', [owner, batch, b.id]);
      });
    } finally { gate.release(); }
    await assertion;
    expect((await db.query('SELECT counting_eligible,version FROM career.applications WHERE id=$1', [a.id])).rows[0]).toEqual({ counting_eligible: true, version: 1 });
  });
  it('mapeia clientId perdedor para resultado canônico e recusa outro corpo depois', async () => {
    const winner = save(); const a = await application(winner);
    const alias = { ...winner, clientId: randomUUID(), evidence: evidence() };
    const before = (await db.query('SELECT version FROM career.applications WHERE id=$1', [a.id])).rows;
    expect((await application(alias)).id).toBe(a.id);
    const mapping = (await db.query('SELECT result_application_id FROM career.creation_requests WHERE client_id=$1', [alias.clientId])).rows;
    expect(mapping).toEqual([{ result_application_id: a.id }]);
    expect((await application(alias, createApplicationService(second))).id).toBe(a.id);
    await expect(call({ ...alias, data: { ...alias.data, track: 'Outra trilha' } })).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT version FROM career.applications WHERE id=$1', [a.id])).rows).toEqual(before);
  });
  it('mesmo clientId/chave entre atores cria uma entidade e dois envelopes seguros', async () => {
    const command = save(); const key = randomUUID();
    const [a, b] = await Promise.all([call(command, service, actor, key), call(command, createApplicationService(second), actorAgain, key)]);
    expect(a.body.application?.id).toBe(b.body.application?.id);
    const mappings = await db.query('SELECT id FROM career.creation_requests WHERE owner_id=$1 AND entity_type=\'application\' AND client_id=$2', [owner, command.clientId]);
    expect(mappings.rowCount).toBe(1);
    expect((await db.query('SELECT actor_kind FROM career.mutation_keys WHERE owner_id=$1 AND idempotency_key=$2 ORDER BY actor_kind', [owner, key])).rows).toEqual([{ actor_kind: 'agent' }, { actor_kind: 'owner' }]);
  });
  it('falha depois de eventos e mapeamento reverte todos os registros provisórios', async () => {
    const count = async () => (await db.query(`SELECT
      (SELECT count(*) FROM career.opportunities WHERE owner_id=$1)::int AS opportunities,
      (SELECT count(*) FROM career.applications WHERE owner_id=$1)::int AS applications,
      (SELECT count(*) FROM career.evidence WHERE owner_id=$1)::int AS evidence,
      (SELECT count(*) FROM career.events WHERE owner_id=$1)::int AS events,
      (SELECT count(*) FROM career.creation_requests WHERE owner_id=$1)::int AS mappings,
      (SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audit`, [owner])).rows[0];
    const before = await count();
    const failing = { ...first, async transaction<T>(who: typeof actor, work: (tx: AuthenticatedTransaction) => Promise<T>, context?: RequestContext) {
      return first.transaction(who, async (tx) => work({ ...tx, query: async <Row extends pg.QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await tx.query<Row>(sql, values);
        if (sql.startsWith('INSERT INTO career.creation_requests') && values?.[1] === 'application') throw new Error('Falha sintética após todos os registros.');
        return result;
      } }), context);
    } };
    const command = save(); const key = randomUUID();
    await expect(call(command, createApplicationService(failing), actor, key)).rejects.toMatchObject({ status: 503 });
    expect(await count()).toEqual(before);
    expect((await db.query('SELECT id FROM career.mutation_keys WHERE idempotency_key=$1', [key])).rowCount).toBe(0);
    expect((await call(command, service, actor, key)).status).toBe(201);
  });
  it('correção após fechamento concorrente preserva snapshot e sinaliza retificação', async () => {
    const app = await application(save()); const { batch } = await batchFixture([app.id]);
    const gate = pauseAfterDiscovery();
    const pending = call({ operation: 'invalidate_submission', application: { id: app.id, expectedVersion: 1 }, affectedBatches: [{ id: batch, expectedVersion: 1 }], reason: 'Retificação posterior', evidence: evidence() }, gate.service);
    await gate.started;
    try {
      await second.transaction(actor, async (tx) => {
        await tx.query('SELECT id FROM career.batches WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner, batch]);
        await tx.query("INSERT INTO career.review_versions(owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids) VALUES($1,$2,1,'original',$3,$4,'{}')", [owner, batch, { fixture: 'fechamento concorrente' }, [app.id]]);
        await tx.query("UPDATE career.batches SET status='closed' WHERE owner_id=$1 AND id=$2", [owner, batch]);
      });
    } finally { gate.release(); }
    const result = applicationResultSchema.parse((await pending).body);
    expect(result.affectedBatches).toEqual([{ id: batch, version: 2, rectificationPending: true }]);
    expect((await db.query('SELECT eligible,captured_order FROM career.batch_members WHERE batch_id=$1', [batch])).rows).toEqual([{ eligible: true, captured_order: '1' }]);
    expect((await db.query('SELECT population_ids,snapshot FROM career.review_versions WHERE batch_id=$1', [batch])).rows).toEqual([{ population_ids: [app.id], snapshot: { fixture: 'fechamento concorrente' } }]);
  });
  it('unicidade impede corrigir trilha para identidade arquivada e reverte patch conjunto', async () => {
    const command = save(); const a = await application(command);
    const b = await application({ ...command, clientId: randomUUID(), data: { ...command.data, track: 'AI Builder' } });
    await application({ operation: 'archive_application', application: { id: a.id, expectedVersion: 1 } });
    await expect(call({ operation: 'update_application', application: { id: b.id, expectedVersion: 1 }, changes: { track: null }, opportunityPatch: { opportunity: { id: a.opportunity.id, expectedVersion: 1 }, changes: { title: 'Não deve persistir' } } })).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT title,version FROM career.opportunities WHERE id=$1', [a.opportunity.id])).rows[0]).toEqual({ title: 'Engenharia', version: 1 });
    expect((await db.query('SELECT track,version FROM career.applications WHERE id=$1', [b.id])).rows[0]).toEqual({ track: 'AI Builder', version: 1 });
  });
  it('recriar índice com colisão existente falha sem fundir registros', async () => {
    const app = await application(save());
    await db.query('BEGIN');
    try {
      await db.query('DROP INDEX career.applications_canonical_identity');
      await db.query('INSERT INTO career.applications(owner_id,opportunity_id,track) VALUES($1,$2,$3),($1,$2,$4)', [owner, app.opportunity.id, 'AI Engineer', '\tAI  Engineer\u00a0']);
      let code: string | undefined;
      try { await db.query('CREATE UNIQUE INDEX applications_canonical_identity ON career.applications(owner_id,opportunity_id,normalized_track,application_instance) WHERE canonical_application_id IS NULL'); }
      catch (error) { code = (error as { code?: string }).code; }
      expect(code).toBe('23505');
    } finally { await db.query('ROLLBACK'); }
    expect((await db.query('SELECT id FROM career.applications WHERE opportunity_id=$1', [app.opportunity.id])).rowCount).toBe(1);
  });
  it('recalcula comparação e preserva links originais, alternativos e referência local', async () => {
    const create = save(); const originalUrl = 'https://jobs.example.org/Open?token=opaque&jobId=42&utm_source=x#Job42';
    const app = await application({ ...create, data: { ...create.data, links: [{ originalUrl, comparisonUrl: 'https://forged.invalid/', kind: 'vaga', isLocal: false, isPrivate: true }, { originalUrl: 'C:/CVs/cv fictício.pdf', comparisonUrl: 'https://forged.invalid/', kind: 'referência local', isLocal: true, isPrivate: true }] } });
    await application({ operation: 'update_application', application: { id: app.id, expectedVersion: 1 }, changes: { links: [{ originalUrl: 'https://alternate.example.org/42', comparisonUrl: null, kind: 'alternativo', isLocal: false, isPrivate: true }] } });
    const links = (await db.query('SELECT original_url,comparison_url,is_local FROM career.links WHERE application_id=$1 ORDER BY original_url', [app.id])).rows;
    expect(links).toEqual([
      { original_url: 'C:/CVs/cv fictício.pdf', comparison_url: null, is_local: true },
      { original_url: 'https://alternate.example.org/42', comparison_url: 'https://alternate.example.org/42', is_local: false },
      { original_url: originalUrl, comparison_url: 'https://jobs.example.org/Open?jobId=42&token=opaque#Job42', is_local: false },
    ]);
  });
  it('reconcilia data/relação explicitamente com evidência sem outro envio lógico', async () => {

    const app = await application(save());
    const originalEvents = (await db.query('SELECT * FROM career.events WHERE application_id=$1', [app.id])).rows;
    const command = { operation: 'update_application', application: { id: app.id, expectedVersion: 1 }, changes: {}, reconciliation: { submittedDate: day('2026-11-10'), cycleRelation: 'after_reset' }, evidence: evidence() };
    await expect(call({ ...command, evidence: null })).rejects.toMatchObject({ status: 400 });
    const result = applicationResultSchema.parse((await call(command)).body);
    expect(result.application).toMatchObject({ id: app.id, version: 2, submittedDate: day('2026-11-10'), cycleRelation: 'after_reset', cycleOrder: expect.any(Number), submissionStatus: 'confirmado' });
    expect(result.allocationPending).toBe(false);
    expect((await db.query("SELECT * FROM career.events WHERE application_id=$1 AND kind='envio_confirmado'", [app.id])).rows).toEqual(originalEvents);
    expect((await db.query("SELECT occurred_date FROM career.events WHERE application_id=$1 AND kind='correcao'", [app.id])).rows).toEqual([{ occurred_date: day('2026-11-10') }]);
    const memberBatch = (await db.query('SELECT b.id,b.version FROM career.batch_members m JOIN career.batches b ON b.id=m.batch_id WHERE m.application_id=$1', [app.id])).rows[0];
    const corrected = await application({ ...command, affectedBatches: [{ id: memberBatch.id, expectedVersion: memberBatch.version }], application: { id: app.id, expectedVersion: 2 }, reconciliation: { submittedDate: day('2026-11-11'), cycleRelation: 'after_reset' }, evidence: evidence() });
    expect(corrected.submittedDate).toEqual(day('2026-11-11'));
    expect((await db.query("SELECT count(*)::int AS n FROM career.events WHERE application_id=$1 AND kind='envio_confirmado'", [app.id])).rows[0].n).toBe(1);
  });
  it('reconciliação usa versões de lote e altera elegibilidade aberta sem renumerar', async () => {
    const command = save(); const app = await application(command);
    await db.query('UPDATE career.applications SET cycle_order=73 WHERE id=$1', [app.id]);
    const { batch } = await batchFixture([app.id]);
    const update = { operation: 'update_application', application: { id: app.id, expectedVersion: 1 }, changes: {}, reconciliation: { submittedDate: unknownDate, cycleRelation: 'before_reset' }, evidence: evidence(), affectedBatches: [{ id: batch, expectedVersion: 1 }] };
    await expect(call({ ...update, affectedBatches: [] })).rejects.toMatchObject({ status: 409 });
    const result = applicationResultSchema.parse((await call(update)).body);
    expect(result.application).toMatchObject({ cycleOrder: 73, cycleRelation: 'before_reset', countingEligible: true });
    expect(result.affectedBatches).toEqual([{ id: batch, version: 2, rectificationPending: false }]);
    expect((await db.query('SELECT captured_order,eligible FROM career.batch_members WHERE batch_id=$1', [batch])).rows).toEqual([{ captured_order: '1', eligible: false }]);
    const restored = applicationResultSchema.parse((await call({ ...update, application: { id: app.id, expectedVersion: 2 }, reconciliation: { submittedDate: day('2026-11-12'), cycleRelation: 'after_reset' }, affectedBatches: [{ id: batch, expectedVersion: 2 }], evidence: evidence() })).body);
    expect(restored.application?.cycleOrder).toBe(73); expect(restored.allocationPending).toBe(false);
    expect((await db.query('SELECT captured_order,eligible FROM career.batch_members WHERE batch_id=$1', [batch])).rows).toEqual([{ captured_order: '1', eligible: true }]);
  });
  it('reconciliação fechada mantém população/snapshot e marca retificação pendente', async () => {
    const app = await application(save()); const { batch } = await batchFixture([app.id], true);
    const members = (await db.query('SELECT * FROM career.batch_members WHERE batch_id=$1', [batch])).rows;
    const snapshots = (await db.query('SELECT * FROM career.review_versions WHERE batch_id=$1', [batch])).rows;
    const result = applicationResultSchema.parse((await call({ operation: 'update_application', application: { id: app.id, expectedVersion: 1 }, changes: {}, reconciliation: { submittedDate: day('2026-10-01'), cycleRelation: 'before_reset' }, affectedBatches: [{ id: batch, expectedVersion: 1 }], evidence: evidence() })).body);
    expect(result.application?.submittedDate).toEqual(day('2026-10-01'));
    expect(result.affectedBatches).toEqual([{ id: batch, version: 2, rectificationPending: true }]);
    expect((await db.query('SELECT * FROM career.batch_members WHERE batch_id=$1', [batch])).rows).toEqual(members);
    expect((await db.query('SELECT * FROM career.review_versions WHERE batch_id=$1', [batch])).rows).toEqual(snapshots);
  });
  it('recusa credenciais em links e reverte integralmente save/update sem registrar a URL', async () => {
    const inventory = async () => (await db.query(`SELECT
      (SELECT count(*) FROM career.opportunities WHERE owner_id=$1)::int AS opportunities,
      (SELECT count(*) FROM career.applications WHERE owner_id=$1)::int AS applications,
      (SELECT count(*) FROM career.links WHERE owner_id=$1)::int AS links,
      (SELECT count(*) FROM career.evidence WHERE owner_id=$1)::int AS evidence,
      (SELECT count(*) FROM career.events WHERE owner_id=$1)::int AS events,
      (SELECT count(*) FROM career.creation_requests WHERE owner_id=$1)::int AS mappings,
      (SELECT count(*) FROM career.mutation_keys WHERE owner_id=$1)::int AS keys,
      (SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audit`, [owner])).rows[0];
    const app = await application(save());
    const original = (await db.query('SELECT * FROM career.applications WHERE id=$1', [app.id])).rows;
    const before = await inventory();
    for (const authority of ['fictional-user:fictional-password', 'fictional-user', ':fictional-password', '%75ser:%70ass']) {
      const links = [
        { originalUrl: 'https://jobs.example.org/Original?token=opaque#Keep', comparisonUrl: null, kind: 'vaga', isLocal: false, isPrivate: true },
        { originalUrl: `https://${authority}@jobs.example.org/Open`, comparisonUrl: null, kind: 'vaga', isLocal: false, isPrivate: true },
      ];
      const create = save();
      await expect(call({ ...create, data: { ...create.data, links } })).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
      expect(await inventory()).toEqual(before);
      await expect(call({ operation: 'update_application', application: { id: app.id, expectedVersion: 1 }, changes: { notes: 'Alteração fictícia que deve ser revertida.', links }, evidence: evidence() })).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
      expect(await inventory()).toEqual(before);
      expect((await db.query('SELECT * FROM career.applications WHERE id=$1', [app.id])).rows).toEqual(original);
    }
  });
  it('aceita UUID maiúsculo no patch da oportunidade sem alterar texto de rótulos', async () => {
    const app = await application(save());
    const result = await application({ operation: 'update_application', application: { id: app.id.toUpperCase(), expectedVersion: 1 }, changes: {}, opportunityPatch: { opportunity: { id: app.opportunity.id.toUpperCase(), expectedVersion: 1 }, changes: { title: 'AI Engineer' } } });
    expect(result).toMatchObject({ id: app.id, version: 2, opportunity: { id: app.opportunity.id, version: 2 } });
    expect((await db.query('SELECT title FROM career.opportunities WHERE id=$1', [app.opportunity.id])).rows).toEqual([{ title: 'AI Engineer' }]);
  });
  it('aceita UUID maiúsculo de lote em reconciliação/correção e recusa duplicata de caixa', async () => {
    const app = await application(save()); const { batch } = await batchFixture([app.id]);
    const reference = { id: batch.toUpperCase(), expectedVersion: 1 };
    const command = { operation: 'update_application', application: { id: app.id.toUpperCase(), expectedVersion: 1 }, changes: {}, reconciliation: { submittedDate: day('2026-11-10'), cycleRelation: 'after_reset' }, evidence: evidence(), affectedBatches: [reference] };
    await expect(call({ ...command, affectedBatches: [reference, { ...reference, id: batch.toLowerCase() }] })).rejects.toMatchObject({ status: 400 });
    const reconciled = applicationResultSchema.parse((await call(command)).body);
    expect(reconciled.affectedBatches).toEqual([{ id: batch, version: 2, rectificationPending: false }]);
    const corrected = applicationResultSchema.parse((await call({ operation: 'invalidate_submission', application: { id: app.id.toUpperCase(), expectedVersion: 2 }, reason: 'Correção fictícia', evidence: evidence(), affectedBatches: [{ id: batch.toUpperCase(), expectedVersion: 2 }] })).body);
    expect(corrected.application).toMatchObject({ id: app.id, version: 3, countingEligible: false });
    expect(corrected.affectedBatches).toEqual([{ id: batch, version: 3, rectificationPending: false }]);
  });
});
