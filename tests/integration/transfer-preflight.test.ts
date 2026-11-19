import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { buildSnapshot, canonicalJson } from '../../domain/export';
import type { TransferEntity } from '../../shared/transfer';
import { authenticateBearer } from '../../server/auth';
import { createDatabase } from '../../server/database';
import { readServerConfig } from '../../server/config';
import { createExportService } from '../../server/services/exports';
import { localDatabaseConfig } from '../../scripts/local-db';
import { provisionOwner } from '../../scripts/provision-owner';
import { restorePrivate } from '../../scripts/restore-private';
import { sha256 } from '../../domain/import';

const emptyContinuity = { displayHighWater: '0', retiredClients: [], retiredKeys: [] };
const owner = randomUUID();
const time = '2026-11-16T10:20:30.123456+00:00';
const unknown = { precision: 'unknown' as const, value: null };
const base = () => ({ id: randomUUID(), version: 1, createdAt: time, updatedAt: time });
const contact = (patch = {}): TransferEntity => ({ formatVersion: 1, table: 'contacts', data: { ...base(), name: 'Fictício', notes: null, ...patch } });
const settings = (patch = {}): TransferEntity => ({ formatVersion: 1, table: 'owner_settings', data: { ...base(), dailyGoal: 5, timezone: 'America/Sao_Paulo', ...patch } });
const cycle = (): TransferEntity => ({ formatVersion: 1, table: 'cycles', data: { ...base(), resetDate: unknown, resetMarker: null, nextOrder: 1, isCurrent: true } });
const batch = (parent: TransferEntity, patch = {}): TransferEntity => ({ formatVersion: 1, table: 'batches', data: { ...base(), cycleId: parent.data.id, batchNumber: 1, status: 'closed', target: 30, rectificationPending: false, ...patch } });
const opportunity = (): TransferEntity => ({ formatVersion: 1, table: 'opportunities', data: { ...base(), company: null, title: null, platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'desconhecido', seniority: null, modality: null, description: null, stack: [] } });
const application = (parent: TransferEntity, patch = {}): TransferEntity => ({ formatVersion: 1, table: 'applications', data: { ...base(), opportunityId: parent.data.id, legacyId: null, displayId: 'N000001', track: null, applicationInstance: 'initial', submissionStatus: 'nao_confirmado', submittedDate: unknown, stage: 'desconhecida', discoveryChannel: null, submissionPlatform: null, notes: null, cycleRelation: 'unknown', cycleOrder: null, countingEligible: true, archivedAt: null, canonicalApplicationId: null, legacyRegisteredDate: unknown, legacyResumeText: null, ...patch } });
function review(parent: TransferEntity, patch = {}): TransferEntity {
    return { formatVersion: 1, table: 'review_versions', data: { ...base(), batchId: parent.data.id, versionNumber: 1, type: 'original', snapshot: { schemaVersion: 1, asOf: time, period: null, populationIds: [], eventIds: [], metrics: {} }, populationIds: [], eventIds: [], narrative: null, decisions: [], predecessorId: null, calculationVersion: null, closedAt: null, reason: null, evidenceId: null, originalMarkdown: null, importProvenance: null, ...patch } };
}
const audit = (patch = {}): TransferEntity => ({ formatVersion: 1, table: 'audit_log', data: { id: randomUUID(), actor: { kind: 'owner', id: owner }, source: 'fixture', occurredAt: time, entityType: 'contacts', entityId: randomUUID(), operation: 'insert', beforeData: null, afterData: {}, diff: {}, requestId: randomUUID(), createdAt: time, ...patch } });
let admin: pg.Client;
let tableNames: string[];
let runtime: ReturnType<typeof createDatabase>;
let actor: Awaited<ReturnType<typeof authenticateBearer>>;
let maintenance: pg.ClientConfig;
beforeAll(async () => {
    admin = new pg.Client(localDatabaseConfig(process.env.LOCAL_RESTORE_TEST_DATABASE_URL));
    await admin.connect();
    tableNames = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='career' ORDER BY tablename")).rows.map(row => row.tablename);
});
beforeEach(async () => {
    const apiPassword = randomBytes(32).toString('base64url');
    const restorePassword = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_RESTORE_TEST_DATABASE_URL, ownerId: owner, apiPassword, restorePassword, restoreReady: true });
    const url = new URL(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!);
    url.username = 'career_api'; url.password = apiPassword;
    const config = readServerConfig({ NODE_ENV: 'test', OWNER_USER_ID: owner, DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    runtime = createDatabase(config);
    actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
    url.username = 'career_restore'; url.password = restorePassword;
    maintenance = localDatabaseConfig(url.href);
});
afterEach(async () => {
    await runtime?.close();
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    for (const table of tableNames) await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await admin.query('COMMIT');
});
afterAll(async () => { await admin?.end(); });
async function bootstrapState() {
    const counts: Record<string, number> = {};
    for (const table of tableNames) counts[table] = Number((await admin.query(`SELECT count(*) AS n FROM career.${table}`)).rows[0].n);
    const state = (await admin.query('SELECT to_jsonb(m) AS row FROM career.maintenance_state m')).rows;
    return { counts, state };
}
const cases: [string, () => TransferEntity[]][] = [
    ['timestamp Z', () => [contact({ createdAt: '2026-11-16T10:20:30.123456Z' })]],
    ['timestamp offset', () => [contact({ createdAt: '2026-11-16T07:20:30.123456-03:00' })]],
    ['timestamp nanoseconds', () => [contact({ updatedAt: '2026-11-16T10:20:30.123456789+00:00' })]],
    ['UUID uppercase', () => [contact({ id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' })]],
    ['integer dailyGoal', () => [contact(), settings({ dailyGoal: 2147483648 })]],
    ['text NUL', () => [contact(), contact({ name: 'literal\u0000inválido' })]],
    ['JSON NUL', () => [{ formatVersion: 1, table: 'audit_log', data: { id: randomUUID(), actor: { kind: 'owner', id: owner }, source: 'fixture', occurredAt: time, entityType: 'contacts', entityId: randomUUID(), operation: 'insert', beforeData: null, afterData: { value: 'nul\u0000' }, diff: {}, requestId: randomUUID(), createdAt: time } }]],
    ['duplicate owner settings', () => [settings(), settings()]],
    ['whitespace task', () => { const parent = contact(); return [parent, { formatVersion: 1, table: 'tasks', data: { ...base(), applicationId: null, contactId: parent.data.id, title: '   ', dueDate: unknown, completedDate: unknown, status: 'pending' } }]; }],
    ['batch integer', () => { const cycle: TransferEntity = { formatVersion: 1, table: 'cycles', data: { ...base(), resetDate: unknown, resetMarker: null, nextOrder: 1, isCurrent: true } }; return [cycle, { formatVersion: 1, table: 'batches', data: { ...base(), cycleId: cycle.data.id, batchNumber: 2147483648, status: 'closed', target: 30, rectificationPending: false } }]; }],
    ['evidence timestamp', () => [{ formatVersion: 1, table: 'evidence', data: { ...base(), kind: 'relato_usuario', originalText: null, source: null, capturedAt: '2026-11-16T10:20:30.123456Z', occurredDate: null, privateRef: null, localRef: null } }]],
    ['audit timestamp', () => [audit({ occurredAt: '2026-11-16T10:20:30.123456Z' })]],
    ['archive timestamp', () => { const op = opportunity(); return [op, application(op, { archivedAt: '2026-11-16T10:20:30.123456Z' })]; }],
    ['review timestamp', () => { const c = cycle(), b = batch(c); return [c, b, review(b, { closedAt: '2026-11-16T10:20:30.123456Z' })]; }],
    ['audit UUID', () => [audit({ requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' })]],
    ['JSON NUL key', () => [audit({ afterData: { ['key\u0000']: 'literal' } })]],
    ['unpaired surrogate', () => [contact({ name: '\ud800' })]],
    ['audit null diff', () => [audit({ diff: null })]],
    ['revision without predecessor', () => { const c = cycle(), b = batch(c); return [c, b, review(b, { type: 'revision' })]; }],
    ['review integer', () => { const c = cycle(), b = batch(c); return [c, b, review(b, { versionNumber: 2147483648 })]; }],
    ['batch target integer', () => { const c = cycle(); return [c, batch(c, { target: 2147483648 })]; }],
    ['application instance whitespace', () => { const op = opportunity(); return [op, application(op, { applicationInstance: ' initial ' })]; }],
    ['duplicate application display', () => { const op = opportunity(); return [op, application(op), application(op, { track: 'Outra trilha' })]; }],
    ['generated canonical track collision', () => { const op = opportunity(); return [op, application(op, { track: '.NET' }), application(op, { track: ' .NET ', displayId: 'N000002' })]; }],
    ['link kind whitespace', () => { const parent = contact(); return [parent, { formatVersion: 1, table: 'links', data: { ...base(), applicationId: null, opportunityId: null, contactId: parent.data.id, originalUrl: 'https://example.test', comparisonUrl: null, kind: '   ', isLocal: false, isPrivate: true } }]; }],
    ...(['provider', 'tenant', 'identityValue'] as const).map((field): [string, () => TransferEntity[]] => ['identity whitespace ' + field, () => { const op = opportunity(); return [op, { formatVersion: 1, table: 'opportunity_identities', data: { ...base(), opportunityId: op.data.id, provider: 'fixture', tenant: 'tenant', identityKind: 'job_code', identityValue: 'JOB', verificationEvidenceId: null, [field]: '   ' } }]; }]),
    ['duplicate import run', () => [1, 2].map(() => ({ formatVersion: 1, table: 'import_runs', data: { ...base(), importerVersion: 'fixture', sourceSetHash: 'a'.repeat(64), status: 'completed', pendingIssues: [], unitState: {} } }))],
    ['duplicate source filename', () => { const run: TransferEntity = { formatVersion: 1, table: 'import_runs', data: { ...base(), importerVersion: 'fixture', sourceSetHash: 'a'.repeat(64), status: 'completed', pendingIssues: [], unitState: {} } }; return [run, ...[1, 2].map((): TransferEntity => ({ formatVersion: 1, table: 'source_files', data: { ...base(), importRunId: run.data.id, fileName: 'fixture.txt', fileHash: sha256(''), originalBytesBase64: '', originalText: '' } }))]; }],
];
it.each(cases)('recusa %s antes de alterar qualquer estado e permite operação válida seguinte', async (_label, fixture) => {
    const snapshot = buildSnapshot(owner, fixture(), time, emptyContinuity);
    const before = await bootstrapState();
    const options = { database: maintenance, ownerId: owner, actor, snapshot, chunkSize: 1 };
    const preview = await restorePrivate({ ...options, mode: 'preview' }).then(() => null, error => error);
    const applied = await restorePrivate({ ...options, mode: 'apply' }).then(() => null, error => error);
    expect(preview).toBeInstanceOf(Error);
    expect(applied).toBeInstanceOf(Error);
    expect(applied).not.toHaveProperty('runId');
    expect(await bootstrapState()).toEqual(before);
    await expect(runtime.assertReady()).resolves.toBeUndefined();
    const valid = buildSnapshot(owner, [contact(), settings()], time, emptyContinuity);
    expect(await restorePrivate({ ...options, snapshot: valid, mode: 'apply' })).toMatchObject({ state: 'completed' });
    const exported = await createExportService(runtime).json(actor);
    expect(canonicalJson(exported.entities.filter(row => row.table !== 'audit_log'))).toBe(canonicalJson(valid.entities));
});
it('preserva formatos históricos dentro de JSON/DateValue, texto Unicode e chaves próprias sem normalização', async () => {
    const history = JSON.parse('{"__proto__":{"date":"2026-11-16T10:20:30.123456789Z","id":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"},"ordered":[2,1],"text":"  espaço \\ufeff"}');
    const run: TransferEntity = { formatVersion: 1, table: 'import_runs', data: { ...base(), importerVersion: 'fixture', sourceSetHash: 'a'.repeat(64), status: 'completed', pendingIssues: [], unitState: {} } };
    const binary = Buffer.from([0, 255, 254, 239, 187, 191]);
    const snapshot = buildSnapshot(owner, [contact({ notes: '\ufeff texto Unicode preservado \r\n' }), audit({ beforeData: history, afterData: history }), { formatVersion: 1, table: 'evidence', data: { ...base(), kind: 'relato_usuario', originalText: ' original ', source: null, capturedAt: time, occurredDate: { precision: 'instant', certainty: 'exact', value: '2026-11-16T07:20:30.123456789-03:00' }, privateRef: null, localRef: null } }, run, { formatVersion: 1, table: 'source_files', data: { ...base(), importRunId: run.data.id, fileName: 'binario.bin', fileHash: sha256(binary), originalBytesBase64: binary.toString('base64'), originalText: null } }], time, emptyContinuity);
    const options = { database: maintenance, ownerId: owner, actor, snapshot };
    expect(await restorePrivate({ ...options, mode: 'preview' })).toMatchObject({ state: 'preview' });
    const result = await restorePrivate({ ...options, mode: 'apply' });
    const exported = await createExportService(runtime).json(actor);
    expect(canonicalJson(exported.entities.filter(row => !(row.table === 'audit_log' && row.data.id === result.runId)))).toBe(canonicalJson(snapshot.entities));
});
it('retorna handle incerto na perda do COMMIT inicial e descobre o mesmo run por apply do mesmo arquivo', async () => {
    const snapshot = buildSnapshot(owner, [contact(), settings()], time, emptyContinuity);
    const options = { database: maintenance, ownerId: owner, actor, snapshot, mode: 'apply' as const };
    const original = pg.Client.prototype.query;
    const query = original as (this: pg.Client, sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
    let injected = false;
    pg.Client.prototype.query = async function (this: pg.Client & { user: string; processID: number }, sql: string, values?: unknown[]) {
        const result = await query.call(this, sql, values);
        if (!injected && this.user === 'career_restore' && sql === 'COMMIT') {
            injected = true;
            await admin.query('SELECT pg_terminate_backend($1)', [this.processID]);
            throw Object.assign(Error('perda sintética da confirmação'), { code: 'ECONNRESET' });
        }
        return result;
    } as typeof original;
    let failure: unknown;
    try { failure = await restorePrivate(options).then(() => null, error => error); }
    finally { pg.Client.prototype.query = original; }
    expect(injected).toBe(true);
    expect(failure).toMatchObject({ runId: expect.any(String), outcome: 'unknown' });
    expect((await bootstrapState()).counts.restore_runs).toBe(1);
    await expect(runtime.assertReady()).rejects.toMatchObject({ code: 'MAINTENANCE', status: 503 });
    const before = await bootstrapState();
    await expect(restorePrivate({ ...options, snapshot: buildSnapshot(owner, [contact()], time, emptyContinuity) })).rejects.toThrow();
    expect(await bootstrapState()).toEqual(before);
    const otherOwner = randomUUID();
    const otherActor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', { ownerUserId: otherOwner }, { getUser: async () => ({ data: { user: { id: otherOwner } }, error: null }) });
    const unauthorized = await restorePrivate({ ...options, actor: otherActor, ownerId: otherOwner, reassignOwner: otherOwner }).then(() => null, error => error);
    expect(unauthorized).toBeInstanceOf(Error);
    expect(unauthorized).not.toHaveProperty('runId');
    const originalKey = (await admin.query('SELECT destination_key FROM career.restore_runs WHERE owner_id=$1', [owner])).rows[0].destination_key;
    await admin.query('UPDATE career.restore_runs SET destination_key=$2 WHERE owner_id=$1', [owner, '0'.repeat(64)]);
    await expect(restorePrivate(options)).rejects.toThrow();
    expect(await bootstrapState()).toEqual(before);
    await admin.query('UPDATE career.restore_runs SET destination_key=$2 WHERE owner_id=$1', [owner, originalKey]);
    // O ID omitido por morte do processo não precisa ser consultado no banco.
    const recovered = await restorePrivate(options);
    expect(recovered).toMatchObject({ state: 'completed', runId: (failure as { runId: string }).runId });
    expect(await restorePrivate(options)).toEqual(recovered);
    expect(await restorePrivate({ ...options, mode: 'resume', runId: recovered.runId! })).toEqual(recovered);
    expect((await admin.query("SELECT count(*) AS n FROM career.audit_log WHERE operation='restore'")).rows[0].n).toBe('1');
});
it('distingue falha confirmada antes do COMMIT sem criar handle ou exigir limpeza manual', async () => {
    const snapshot = buildSnapshot(owner, [contact()], time, emptyContinuity);
    const options = { database: maintenance, ownerId: owner, actor, snapshot, mode: 'apply' as const };
    const before = await bootstrapState();
    const original = pg.Client.prototype.query;
    const query = original as (this: pg.Client, sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
    let injected = false;
    pg.Client.prototype.query = async function (this: pg.Client & { user: string }, sql: string, values?: unknown[]) {
        if (!injected && this.user === 'career_restore' && sql.startsWith('INSERT INTO career.restore_runs')) {
            injected = true;
            throw Object.assign(Error('falha sintética antes do envio'), { code: 'ECONNRESET' });
        }
        return query.call(this, sql, values);
    } as typeof original;
    let failure: unknown;
    try { failure = await restorePrivate(options).then(() => null, error => error); }
    finally { pg.Client.prototype.query = original; }
    expect(injected).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('runId');
    expect(await bootstrapState()).toEqual(before);
    expect(await restorePrivate(options)).toMatchObject({ state: 'completed' });
});
