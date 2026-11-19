import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { provisionOwner } from '../../scripts/provision-owner';
import { localDatabaseConfig, runLocalDatabase } from '../../scripts/local-db';
import { authenticateBearer } from '../../server/auth';
import { createDatabase } from '../../server/database';
import { readServerConfig } from '../../server/config';
import { createExportService } from '../../server/services/exports';
import { parse } from 'csv-parse/sync';
import { restorePrivate, restorePrivateMain } from '../../scripts/restore-private';
import { exportPrivateMain } from '../../scripts/export-private';
import { readPrivateSnapshot } from '../../scripts/private-transfer-io';
import { buildSnapshot } from '../../domain/export';
import { canonicalJson } from '../../domain/export';
import { connectTestDatabase } from '../helpers/database';
import { IMPORTER_VERSION, LEGACY_HEADER, PARSER_VERSION, sha256 } from '../../domain/import';
import { createImportService } from '../../server/services/imports';
import { loadAppliedImportStates } from '../../server/repositories/transfers';
import { activityEventProjection } from '../../server/repositories/activity';
import { instantNanoseconds } from '../../domain/dates';
const emptyContinuity = { displayHighWater: '0', retiredClients: [], retiredKeys: [] };
const owner = randomUUID();
const unknown = { precision: 'unknown' as const, value: null };
const time = '2026-11-16T10:20:30.123456+00:00';
const settingsSnapshot = () => buildSnapshot(owner, [{ formatVersion: 1, table: 'owner_settings', data: { id: randomUUID(), version: 1, createdAt: time, updatedAt: time, dailyGoal: 5, timezone: 'America/Sao_Paulo' } }], time, emptyContinuity);
async function waitFor(check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await check())
            return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw Error('A condição concorrente não ocorreu.');
}
let destination: pg.Client;
let sourceAdmin: pg.Client | undefined;
let sourceDb: ReturnType<typeof createDatabase> | undefined;
async function cleanSource() {
    if (!sourceAdmin)
        return;
    await sourceAdmin.query('BEGIN');
    await sourceAdmin.query("SET LOCAL session_replication_role='replica'");
    for (const table of ['mutation_keys', 'agent_credentials', 'creation_requests', 'review_versions', 'batch_members', 'batches', 'import_rows', 'source_files', 'import_runs', 'cycles', 'application_resumes', 'links', 'events', 'tasks', 'contacts', 'evidence', 'resume_refs', 'applications', 'opportunity_identities', 'opportunities', 'owner_settings', 'audit_log', 'restore_row_ledger', 'maintenance_state', 'restore_runs', 'owner_config'])
        await sourceAdmin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await sourceAdmin.query('COMMIT');
}
async function runtime(adminUrl: string, restoreReady: boolean) {
    const apiPassword = randomBytes(32).toString('base64url');
    const restorePassword = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl, ownerId: owner, apiPassword, restorePassword, restoreReady });
    const url = new URL(adminUrl);
    url.username = 'career_api';
    url.password = apiPassword;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    const actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
    url.username = 'career_restore';
    url.password = restorePassword;
    return { db: createDatabase(config), actor, maintenance: localDatabaseConfig(url.href), apiConfig: config };
}
async function cleanFixture() {
    if (!destination)
        return;
    await destination.query('BEGIN');
    await destination.query("SET LOCAL session_replication_role='replica'");
    for (const table of ['mutation_keys', 'agent_credentials', 'creation_requests', 'review_versions', 'batch_members', 'batches', 'import_rows', 'source_files', 'import_runs', 'cycles', 'application_resumes', 'links', 'events', 'tasks', 'contacts', 'evidence', 'resume_refs', 'applications', 'opportunity_identities', 'opportunities', 'owner_settings', 'audit_log', 'restore_row_ledger', 'maintenance_state', 'restore_runs', 'owner_config'])
        await destination.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await destination.query('COMMIT');
}
beforeAll(async () => {
    await runLocalDatabase('apply', process.env.LOCAL_RESTORE_TEST_DATABASE_URL);
    destination = new pg.Client(localDatabaseConfig(process.env.LOCAL_RESTORE_TEST_DATABASE_URL));
    await destination.connect();
});
beforeEach(cleanFixture);
it('drena runtime, mantém manutenção após chunk e permite somente replay autorizado', async () => {
    // Limpa somente a fixture anterior pertencente a este caso conhecido.
    await destination.query('BEGIN');
    await destination.query("SET LOCAL session_replication_role='replica'");
    for (const table of ['applications', 'opportunities', 'audit_log'])
        await destination.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await destination.query('COMMIT');
    const apiPassword = randomBytes(32).toString('base64url');
    const restorePassword = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_RESTORE_TEST_DATABASE_URL, ownerId: owner, apiPassword, restorePassword, restoreReady: true });
    const url = new URL(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!);
    url.username = 'career_api';
    url.password = apiPassword;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    const actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
    const db = createDatabase(config);
    url.username = 'career_restore';
    url.password = restorePassword;
    const restoreConfig = localDatabaseConfig(url.href);
    const time = '2026-11-16T10:20:30.123456+00:00';
    const snapshot = buildSnapshot(owner, [{ formatVersion: 1, table: 'owner_settings', data: { id: randomUUID(), version: 3, createdAt: time, updatedAt: time, dailyGoal: 7, timezone: 'America/Sao_Paulo' } }], time, emptyContinuity);
    const options = { database: restoreConfig, ownerId: owner, actor, snapshot, mode: 'apply' as const, chunkSize: 1 };
    try {
        expect(await restorePrivate({ ...options, mode: 'preview' })).toMatchObject({ state: 'preview', runId: null });
        let held!: () => void;
        let release!: () => void;
        const entered = new Promise<void>(r => { held = r; });
        const gate = new Promise<void>(r => { release = r; });
        const request = db.transaction(actor, async () => { held(); await gate; });
        await entered;
        let done = false;
        const applying = restorePrivate({ ...options, afterChunk: async () => { throw new Error('interrupção sintética'); } }).finally(() => { done = true; });
        await new Promise(r => setTimeout(r, 80));
        expect(done).toBe(false);
        release();
        await request;
        await expect(applying).rejects.toThrow();
        await expect(db.assertReady()).rejects.toMatchObject({ code: 'MAINTENANCE' });
        const run = (await destination.query('SELECT id FROM career.restore_runs WHERE owner_id=$1', [owner])).rows[0]!.id;
        await expect(restorePrivate({ ...options, mode: 'resume', runId: run, snapshot: { ...snapshot, manifest: { ...snapshot.manifest, exportedAt: '2026-11-17T10:20:30Z' } } })).rejects.toThrow();
        expect(await restorePrivate({ ...options, mode: 'resume', runId: run })).toMatchObject({ state: 'completed', runId: run });
        expect(await restorePrivate({ ...options, mode: 'resume', runId: run })).toMatchObject({ state: 'completed', runId: run });
        expect((await createExportService(db).json(actor)).entities.filter(r => r.table !== 'audit_log')).toEqual(snapshot.entities);
        expect((await destination.query("SELECT count(*) FROM career.audit_log WHERE operation='restore' AND owner_id=$1", [owner])).rows[0]!.count).toBe('1');
    }
    finally {
        await db.close();
    }
});
afterAll(async () => {
    await sourceDb?.close();
    await cleanSource();
    await sourceAdmin?.end();
    if (destination) {
        await cleanFixture();
        await destination.end();
    }
});
it('exporta origem completa, retoma no destino e preserva história, registros fortes e baseline serializado', async () => {
    sourceAdmin = await connectTestDatabase();
    const src = await runtime(process.env.LOCAL_TEST_DATABASE_URL!, false);
    sourceDb = src.db;
    const dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, true);
    const id = () => randomUUID();
    const op = id(), app = id(), alias = id(), contact = id(), evidence = id(), event = id(), cv = id(), cycle = id(), batch = id(), review1 = id(), review2 = id(), oldRun = id(), newRun = id(), oldFile = id(), newFile = id();
    const time = '2026-11-16T10:20:30.123456+00:00';
    const unknown = { precision: 'unknown', value: null };
    const interpretation = { track: null, applicationInstance: 'initial', cycleRelation: 'unknown', kind: 'desconhecido', provider: 'fixture', tenant: 'synthetic' };
    const input = { runId: newRun, legacyId: 'V901', expectedVersion: 2, expectedOpportunityVersion: 1, interpretation, decisions: Object.fromEntries(LEGACY_HEADER.map(k => [k, k === 'observacoes' ? 'current' : 'source'])), historicalEvents: [], affectedBatches: [] };
    const record = (note: string) => ['V901', 'Empresa fonte', 'Cargo fonte', 'literal legado', 'JOB-TRANSFER', '', 'https://example.test/original', '', 'confirmado', '', 'Relato literal', 'CV literal', 'Narrativa literal', '', 'fonte literal', note, '2020-01-02'].map(v => '"' + v.replaceAll('"', '""') + '"').join(',') + '\r\n';
    const oldRaw = record('estado antigo');
    const newRaw = record('estado aplicado');
    const large = '\ufeff' + ('Arquivo sintético completo.\r\n'.repeat(2500));
    try {
        await sourceAdmin.query("INSERT INTO career.opportunities(id,owner_id,company,title,platform,tenant,job_code,version) VALUES($1,$2,'Empresa fonte','Cargo fonte','fixture','synthetic','JOB-TRANSFER',2)", [op, owner]);
        await sourceAdmin.query("INSERT INTO career.applications(id,owner_id,opportunity_id,legacy_id,display_id,version,notes,legacy_resume_text,submission_status) VALUES($1,$2,$3,'V901','V901',3,'estado atual','CV literal','confirmado')", [app, owner, op]);
        await sourceAdmin.query("INSERT INTO career.applications(id,owner_id,opportunity_id,display_id,canonical_application_id,archived_at) VALUES($1,$2,$3,'N9007199254740993',$4,$5)", [alias, owner, op, app, time]);
        await sourceAdmin.query("INSERT INTO career.contacts(id,owner_id,name) VALUES($1,$2,'Contato fictício')", [contact, owner]);
        await sourceAdmin.query("INSERT INTO career.evidence(id,owner_id,kind,original_text,captured_at) VALUES($1,$2,'relato_usuario','Texto de evidência',$3)", [evidence, owner, time]);
        await sourceAdmin.query("INSERT INTO career.events(id,owner_id,application_id,kind,state,evidence_id,created_at,updated_at) VALUES($1,$2,$3,'nota','informado',$4,$5,$5)", [event, owner, app, evidence, time]);
        await sourceAdmin.query("INSERT INTO career.tasks(owner_id,application_id,contact_id,title) VALUES($1,$2,$3,'Ação pendente')", [owner, app, contact]);
        await sourceAdmin.query("INSERT INTO career.resume_refs(id,owner_id,label) VALUES($1,$2,'CV informado')", [cv, owner]);
        await sourceAdmin.query('INSERT INTO career.application_resumes(owner_id,application_id,resume_id,is_active) VALUES($1,$2,$3,false)', [owner, app, cv]);
        await sourceAdmin.query("INSERT INTO career.links(owner_id,application_id,contact_id,original_url,kind) VALUES($1,$2,$3,'https://example.test/private?token=synthetic','registro')", [owner, app, contact]);
        await sourceAdmin.query("INSERT INTO career.cycles(id,owner_id,is_current,next_order) VALUES($1,$2,true,31)", [cycle, owner]);
        await sourceAdmin.query("INSERT INTO career.batches(id,owner_id,cycle_id,batch_number,status,rectification_pending) VALUES($1,$2,$3,1,'open',true)", [batch, owner, cycle]);
        await sourceAdmin.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,1)', [owner, batch, app]);
        await sourceAdmin.query("UPDATE career.batches SET status='closed' WHERE id=$1", [batch]);
        const snapshot = { schemaVersion: 1, asOf: time, period: null, populationIds: [app], eventIds: [event], metrics: { total: { numerator: 0, denominator: 0, ratio: null, applicationIds: [] } } };
        const provenance = { historicalClosedDate: { precision: 'day', certainty: 'exact', value: '2026-11-14' }, snapshotTimeMeaning: 'import_capture' };
        await sourceAdmin.query("INSERT INTO career.review_versions(id,owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids,closed_at,import_provenance,created_at,updated_at) VALUES($1,$2,$3,1,'original',$4,$5,$6,NULL,$7,$8,$8)", [review1, owner, batch, snapshot, [app], [event], provenance, time]);
        await sourceAdmin.query("INSERT INTO career.review_versions(id,owner_id,batch_id,version_number,type,snapshot,population_ids,event_ids,predecessor_id,created_at,updated_at) VALUES($1,$2,$3,2,'revision',$4,$5,$6,$7,$8,$8)", [review2, owner, batch, snapshot, [app], [event], review1, time]);
        for (const [kind, result, column] of [['application', app, 'result_application_id'], ['cycle', cycle, 'result_cycle_id'], ['resume_ref', cv, 'result_resume_id'], ['evidence', evidence, 'result_evidence_id']] as const)
            await sourceAdmin.query(`INSERT INTO career.creation_requests(owner_id,entity_type,client_id,payload_hash,${column}) VALUES($1,$2,$3,$4,$5)`, [owner, kind, id(), 'a'.repeat(64), result]);
        for (const [run, file, raw, version, created] of [[oldRun, oldFile, oldRaw, 1, '2026-11-16T12:00:00.123456Z'], [newRun, newFile, newRaw, 3, '2026-11-16T11:00:00.654321Z']] as const) {
            const bytes = Buffer.from(LEGACY_HEADER.join(',') + '\r\n' + raw);
            const sources = [{ name: 'controle.csv', sha256: sha256(bytes) }, ...(run === newRun ? [{ name: 'grande.md', sha256: sha256(large) }] : [])];
            const sourceSetHash = sha256(JSON.stringify({ importer: IMPORTER_VERSION, parser: PARSER_VERSION, sources }));
            await src.db.transaction(src.actor, async (tx) => {
                await tx.query("INSERT INTO career.import_runs(id,owner_id,importer_version,source_set_hash,status,unit_state) VALUES($1,$2,'legacy-preview/2',$3,'completed',$4)", [run, owner, sourceSetHash, { cycleId: cycle, cycleConfig: { id: cycle, resetDate: unknown, resetMarker: null, isCurrent: true }, completed: { reviewRequired: false, runId: run, rowCount: 1 } }]);
                await tx.query("INSERT INTO career.source_files(id,owner_id,import_run_id,file_name,file_hash,original_bytes,original_text,created_at,updated_at) VALUES($1,$2,$3,'controle.csv',$4,$5,$6,$7,$7)", [file, owner, run, sha256(bytes), bytes, bytes.toString('utf8'), time]);
                const request = version === 1 ? { ...input, runId: run, expectedVersion: null, expectedOpportunityVersion: null, decisions: null } : input;
                await tx.query("INSERT INTO career.import_rows(owner_id,source_file_id,row_number,row_hash,original_text,legacy_id,target_application_id,result,applied_target_version,resolution,unit_result,created_at,updated_at) VALUES($1,$2,2,$3,$4,'V901',$5,'imported',$6,$7,$8,$9,$9)", [owner, file, sha256(raw), raw, app, version, { request, appliedInterpretation: interpretation }, { applicationId: app, version, result: 'imported' }, created]);
            });
        }
        await src.db.transaction(src.actor, tx => tx.query("INSERT INTO career.source_files(owner_id,import_run_id,file_name,file_hash,original_bytes,original_text) VALUES($1,$2,'grande.md',$3,$4,$5)", [owner, newRun, sha256(large), Buffer.from(large), large]));
        const own = JSON.parse('{"__proto__":{"keep":"histórico"},"constructor":"literal"}');
        await sourceAdmin.query("INSERT INTO career.audit_log(owner_id,actor_kind,actor_id,source,entity_type,entity_id,operation,before_data,after_data,diff,request_id,occurred_at,created_at) VALUES($1,'owner',$1::uuid::text,'fixture','applications',$2,'update',$3,$3,$3,$4,$5,$5)", [owner, app, own, id(), time]);
        const accessId = id(), accessClient = id(), accessHash = sha256('segredo sintético descartável');
        await src.db.transaction(src.actor, async (tx) => {
            await tx.query("INSERT INTO career.agent_credentials(id,owner_id,label,prefix,scopes,token_hash) VALUES($1,$2,'Credencial fictícia','synthetic',ARRAY['career:read'],$3)", [accessId, owner, accessHash]);
            await tx.query("INSERT INTO career.creation_requests(owner_id,entity_type,client_id,payload_hash,result_credential_id) VALUES($1,'agent_credential',$2,$3,$4)", [owner, accessClient, 'd'.repeat(64), accessId]);
            await tx.query('UPDATE career.agent_credentials SET revoked_at=now() WHERE id=$1', [accessId]);
        });
        const exported = await createExportService(src.db).json(src.actor);
        const csvRows = parse(await createExportService(src.db).csv(src.actor), { columns: true }) as { id: string; observacoes: string }[];
        expect(csvRows).toHaveLength(2);
        expect(csvRows.find(row => row.id === 'N9007199254740993')?.observacoes).toBe('');
        expect(csvRows.find(row => row.id === 'V901')?.observacoes).toBe('estado atual');
        expect(JSON.stringify(exported)).not.toContain(accessHash);
        expect(JSON.stringify(exported)).not.toContain('result_credential_id');
        expect(exported.entities.filter(r => r.table === 'creation_requests')).toHaveLength(4);
        expect(exported.entities.some(r => r.table === 'creation_requests' && r.data.clientId === accessClient)).toBe(false);
        expect(exported.entities.some(r => r.table === 'audit_log' && r.data.entityId === accessId)).toBe(true);
        expect(() => buildSnapshot(owner, exported.entities.map(row => row.table === 'import_rows' ? { ...row, data: { ...row.data, unitResult: { applicationId: randomUUID(), version: 3, result: 'imported' } } } : row))).toThrow();
        expect(exported.manifest.tables.every(t => t.count > 0)).toBe(true);
        await expect(restorePrivate({ database: dst.maintenance, ownerId: owner, actor: dst.actor, snapshot: exported, mode: 'apply', chunkSize: 4, afterChunk: async () => { throw Error('interrupção sintética'); } })).rejects.toThrow();
        const runId: string = (await destination.query('SELECT id FROM career.restore_runs WHERE owner_id=$1', [owner])).rows[0]!.id;
        await restorePrivate({ database: dst.maintenance, ownerId: owner, actor: dst.actor, snapshot: exported, mode: 'resume', runId, chunkSize: 4 });
        const restored = await createExportService(dst.db).json(dst.actor);
        expect(canonicalJson(restored.entities.filter(r => !(r.table === 'audit_log' && r.data.id === runId)))).toBe(canonicalJson(exported.entities));
        const knowledge = await dst.db.transaction(dst.actor, tx => activityEventProjection(tx, owner, event));
        expect(knowledge.recordedAt).toBe('2026-11-16T10:20:30.123456Z');
        expect(instantNanoseconds(knowledge.recordedAt)).toBeGreaterThan(instantNanoseconds('2026-11-16T10:20:30.123455Z'));
        expect(await dst.db.transaction(dst.actor, tx => loadAppliedImportStates(tx, owner))).toMatchObject([{ rawRowHash: sha256(newRaw), importedApplicationVersion: 3, originalText: newRaw }]);
        expect(await createImportService(dst.db).preview(dst.actor, { runId: newRun })).toMatchObject({ diff: [{ legacyId: 'V901', kind: 'unchanged' }] });
        expect(await createImportService(dst.db).applyApplication(dst.actor, input)).toMatchObject({ applicationId: app, version: 3, result: 'imported' });
        const display = await dst.db.transaction(dst.actor, async (tx) => (await tx.query("INSERT INTO career.applications(owner_id,opportunity_id,track) VALUES($1,$2,'Trilha após recuperação') RETURNING display_id AS id", [owner, op])).rows[0]!.id);
        expect(BigInt(String(display).slice(1))).toBeGreaterThan(9007199254740993n);
    }
    finally {
        await dst.db.close();
    }
});
it('bootstrap de recuperação omite defaults de negócio sem alterar provisionamento normal', async () => {
    await provisionOwner({ adminUrl: process.env.LOCAL_RESTORE_TEST_DATABASE_URL, ownerId: owner, apiPassword: randomBytes(32).toString('base64url'), restorePassword: randomBytes(32).toString('base64url'), restoreReady: true });
    expect((await destination.query('SELECT count(*) FROM career.owner_settings')).rows[0]!.count).toBe('0');
    expect((await destination.query('SELECT count(*) FROM career.cycles')).rows[0]!.count).toBe('0');
});
it('exporta pela sessão real da API com precisão SQL, dados atuais e limite consistente', async () => {
    const password = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_RESTORE_TEST_DATABASE_URL, ownerId: owner, apiPassword: password, restorePassword: randomBytes(32).toString('base64url'), restoreReady: true });
    const url = new URL(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!);
    url.username = 'career_api';
    url.password = password;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    const db = createDatabase(config);
    const actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
    try {
        const op = randomUUID();
        const app = randomUUID();
        await destination.query("INSERT INTO career.opportunities(id,owner_id,company,title,created_at,updated_at) VALUES($1,$2,'=Company, Test','Cargo','2026-11-16T10:20:30.123456Z','2026-11-16T10:20:30.654321Z')", [op, owner]);
        await destination.query('INSERT INTO career.applications(id,owner_id,opportunity_id) VALUES($1,$2,$3)', [app, owner, op]);
        const service = createExportService(db);
        const snapshot = await service.json(actor);
        const exported = snapshot.entities.find((row) => row.table === 'opportunities');
        expect(exported?.data.createdAt).toBe('2026-11-16T10:20:30.123456+00:00');
        const csv = parse(await service.csv(actor), { columns: true });
        expect(csv[0]).toMatchObject({ empresa: "'=Company, Test", cargo: 'Cargo', data_envio: '', etapa: '' });
        await destination.query('UPDATE career.applications SET submitted_date=$2 WHERE id=$1', [app, { precision: 'instant', certainty: 'exact', value: '2026-11-16T01:30:00Z' }]);
        const datedCsv = parse(await service.csv(actor), { columns: true }) as {
            data_envio: string;
        }[];
        expect(datedCsv[0]?.data_envio).toBe('2026-11-15');
    }
    finally {
        await db.close();
    }
});
it('recusa negócio ocupado em qualquer proprietário e credenciais ativas sem ler hashes', async () => {
    const dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, true);
    const options = { database: dst.maintenance, ownerId: owner, actor: dst.actor, snapshot: settingsSnapshot(), mode: 'preview' as const };
    const other = randomUUID(), contact = randomUUID(), credential = randomUUID();
    const maintenance = new pg.Client(dst.maintenance);
    try {
        await maintenance.connect();
        await expect(maintenance.query('SELECT token_hash FROM career.agent_credentials')).rejects.toMatchObject({ code: '42501' });
        await destination.query("INSERT INTO career.contacts(id,owner_id,name) VALUES($1,$2,'Outro proprietário sintético')", [contact, other]);
        await expect(restorePrivate(options)).rejects.toThrow();
        await destination.query('DELETE FROM career.contacts WHERE id=$1', [contact]);
        await destination.query("INSERT INTO career.agent_credentials(id,owner_id,label,prefix,scopes,token_hash) VALUES($1,$2,'Fixture','synthetic',ARRAY['career:read'],$3)", [credential, other, 'b'.repeat(64)]);
        await expect(restorePrivate(options)).rejects.toThrow();
        await destination.query('DELETE FROM career.agent_credentials WHERE id=$1', [credential]);
        await destination.query('INSERT INTO career.owner_settings(owner_id) VALUES($1)', [owner]);
        await expect(restorePrivate(options)).rejects.toThrow();
        expect((await destination.query('SELECT count(*) FROM career.restore_runs')).rows[0]!.count).toBe('0');
        expect((await destination.query('SELECT state FROM career.maintenance_state')).rows[0]!.state).toBe('ready');
    }
    finally {
        await maintenance.end();
        await dst.db.close();
        await destination.query('DELETE FROM career.contacts WHERE id=$1', [contact]);
        await destination.query('DELETE FROM career.agent_credentials WHERE id=$1', [credential]);
    }
});
it('separa os logins reais e não confia em flags runtime para manutenção, auditoria ou identidade', async () => {
    const dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, true);
    const maintenance = new pg.Client(dst.maintenance);
    try {
        await maintenance.connect();
        await expect(restorePrivate({ database: dst.apiConfig.database, ownerId: owner, actor: dst.actor, snapshot: settingsSnapshot(), mode: 'preview' })).rejects.toThrow();
        await expect(dst.db.transaction(dst.actor, tx => tx.query("UPDATE career.maintenance_state SET state='failed'"))).rejects.toMatchObject({ code: '42501' });
        await expect(dst.db.transaction(dst.actor, tx => tx.query('SELECT * FROM career.restore_runs'))).rejects.toMatchObject({ code: '42501' });
        await expect(maintenance.query('INSERT INTO career.owner_settings(owner_id) VALUES($1)', [owner])).rejects.toMatchObject({ code: '42501' });
        const metadata = (await maintenance.query("SELECT rolbypassrls,rolsuper,rolcreaterole,rolcreatedb,EXISTS(SELECT FROM pg_auth_members WHERE member=pg_roles.oid) AS membership FROM pg_roles WHERE rolname=current_user")).rows[0];
        expect(Object.values(metadata)).toEqual([false, false, false, false, false]);
        expect((await maintenance.query("SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='career'::regnamespace AND relkind='r'")).rows[0]!.protected).toBe(true);
        await dst.db.transaction(dst.actor, async (tx) => {
            await tx.query("SELECT set_config('app.restore','true',true),set_config('app.restore_run_id',$1,true)", [randomUUID()]);
            const op = (await tx.query("INSERT INTO career.opportunities(owner_id,company,platform,tenant,job_code) VALUES($1,'Fixture runtime','fixture','runtime','X') RETURNING id", [owner])).rows[0]!.id;
            expect((await tx.query('SELECT count(*) FROM career.opportunity_identities WHERE opportunity_id=$1', [op])).rows[0]!.count).toBe('1');
            expect((await tx.query("SELECT count(*) FROM career.audit_log WHERE entity_type='opportunities' AND entity_id=$1", [op])).rows[0]!.count).toBe('1');
        });
    }
    finally {
        await maintenance.end();
        await dst.db.close();
    }
});
it('recusa linha estranha durante interrupção mesmo quando dados e ID coincidem com o manifesto', async () => {
    const dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, true);
    const base = { id: randomUUID(), version: 1, createdAt: time, updatedAt: time };
    const snapshot = buildSnapshot(owner, [...settingsSnapshot().entities, { formatVersion: 1, table: 'contacts', data: { ...base, name: 'Contato', notes: null } }], time, emptyContinuity);
    const options = { database: dst.maintenance, ownerId: owner, actor: dst.actor, snapshot, mode: 'apply' as const, chunkSize: 1 };
    const settings = snapshot.entities.find(row => row.table === 'owner_settings')!;
    const other = randomUUID();
    try {
        await expect(restorePrivate({ ...options, afterChunk: async () => { throw Error('interrupção'); } })).rejects.toThrow();
        const run = (await destination.query('SELECT id FROM career.restore_runs WHERE owner_id=$1', [owner])).rows[0]!.id;
        for (const insertedOwner of [owner, other]) {
            await destination.query('INSERT INTO career.owner_settings(id,owner_id,version,created_at,updated_at) VALUES($1,$2,1,$3,$3)', [settings.data.id, insertedOwner, time]);
            await expect(restorePrivate({ ...options, mode: 'resume', runId: run })).rejects.toThrow();
            expect((await destination.query('SELECT state FROM career.maintenance_state')).rows[0]!.state).toBe('restoring');
            await destination.query('DELETE FROM career.owner_settings WHERE id=$1', [settings.data.id]);
        }
        await restorePrivate({ ...options, mode: 'resume', runId: run });
    }
    finally {
        await dst.db.close();
        await destination.query('DELETE FROM career.owner_settings WHERE owner_id=$1', [other]);
    }
});
it('reverte linha e ledger de chunk abortado por perda real da conexão e retoma o prefixo confirmado', async () => {
    const dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, true);
    const contact1 = randomUUID(), contact2 = randomUUID();
    const base = { version: 1, createdAt: time, updatedAt: time };
    const snapshot = buildSnapshot(owner, [...settingsSnapshot().entities, ...[contact1, contact2].map(id => ({ formatVersion: 1 as const, table: 'contacts' as const, data: { ...base, id, name: 'Contato', notes: null } })), { formatVersion: 1, table: 'tasks', data: { ...base, id: randomUUID(), applicationId: null, contactId: contact1, title: 'Tarefa', dueDate: unknown, completedDate: unknown, status: 'pending' } }], time, emptyContinuity);
    let committed!: () => void;
    let advance!: () => void;
    const first = new Promise<void>(r => { committed = r; });
    const gate = new Promise<void>(r => { advance = r; });
    const blocker = new pg.Client(localDatabaseConfig(process.env.LOCAL_RESTORE_TEST_DATABASE_URL));
    await blocker.connect();
    let transaction = false;
    const options = { database: dst.maintenance, ownerId: owner, actor: dst.actor, snapshot, mode: 'apply' as const, chunkSize: 2 };
    const applying = restorePrivate({ ...options, afterChunk: async () => { committed(); await gate; } });
    const outcome = applying.then(() => false, () => true);
    try {
        await first;
        await blocker.query('BEGIN');
        transaction = true;
        await blocker.query('SELECT id FROM career.contacts WHERE id=$1 FOR UPDATE', [contact1]);
        advance();
        let pid: number | undefined;
        await waitFor(async () => { pid = (await destination.query("SELECT pid FROM pg_stat_activity WHERE usename='career_restore' AND wait_event_type='Lock' AND query LIKE 'INSERT INTO career.tasks %'")).rows[0]?.pid; return Boolean(pid); });
        await destination.query('SELECT pg_terminate_backend($1)', [pid]);
        expect(await outcome).toBe(true);
        await blocker.query('ROLLBACK');
        transaction = false;
        expect((await destination.query('SELECT count(*) FROM career.owner_settings')).rows[0]!.count).toBe('0');
        expect((await destination.query('SELECT count(*) FROM career.tasks')).rows[0]!.count).toBe('0');
        expect((await destination.query('SELECT count(*) FROM career.restore_row_ledger')).rows[0]!.count).toBe('2');
        const run = (await destination.query('SELECT id FROM career.restore_runs WHERE owner_id=$1', [owner])).rows[0]!.id;
        await restorePrivate({ ...options, mode: 'resume', runId: run });
        expect((await destination.query('SELECT count(*) FROM career.tasks')).rows[0]!.count).toBe('1');
    }
    finally {
        advance();
        if (transaction)
            await blocker.query('ROLLBACK');
        await blocker.end();
        await outcome;
        await dst.db.close();
    }
});
it('captura todas as tabelas na mesma instrução mesmo com commit concorrente entre projeções', async () => {
    const dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, false);
    const op = randomUUID(), app = randomUUID();
    try {
        await destination.query("INSERT INTO career.opportunities(id,owner_id,company) VALUES($1,$2,'Empresa antes')", [op, owner]);
        await destination.query("INSERT INTO career.applications(id,owner_id,opportunity_id,notes) VALUES($1,$2,$3,'Nota antes')", [app, owner, op]);
        const delayed = { ...dst.db, transaction: (who: Parameters<typeof dst.db.transaction>[0], work: Parameters<typeof dst.db.transaction>[1]) => dst.db.transaction(who, tx => work({ ...tx, query: <Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[]) => tx.query<Row>(sql.startsWith('WITH history') ? sql.replace('WITH history', "WITH delay AS MATERIALIZED (SELECT pg_sleep(0.5)),history").replace('FROM career.owner_settings t', 'FROM career.owner_settings t CROSS JOIN delay') : sql, values) })) } as typeof dst.db;
        const exporting = createExportService(delayed).json(dst.actor);
        await waitFor(async () => (await destination.query("SELECT 1 FROM pg_stat_activity WHERE usename='career_api' AND wait_event='PgSleep' AND query LIKE 'WITH delay%'")).rowCount === 1);
        await destination.query('BEGIN');
        await destination.query("UPDATE career.opportunities SET company='Empresa depois' WHERE id=$1", [op]);
        await destination.query("UPDATE career.applications SET notes='Nota depois' WHERE id=$1", [app]);
        await destination.query('COMMIT');
        const snapshot = await exporting;
        expect(snapshot.entities.find(r => r.table === 'opportunities')).toMatchObject({ data: { company: 'Empresa antes' } });
        expect(snapshot.entities.find(r => r.table === 'applications')).toMatchObject({ data: { notes: 'Nota antes' } });
    }
    finally {
        await dst.db.close();
    }
});
it('executa os scripts com sessão verificada por HTTP e arquivos privados sem imprimir credenciais', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'career-private-cli-'));
    let dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, false);
    const token = 'eyJhIjox.eyJiIjoy.signature';
    let verified = 0;
    const auth = createServer((req, res) => {
        if (req.url !== '/auth/v1/user' || req.headers.authorization !== 'Bearer ' + token) {
            res.writeHead(401);
            res.end('{}');
            return;
        }
        verified++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: owner, aud: 'authenticated', role: 'authenticated', created_at: '2026-11-16T00:00:00Z', app_metadata: {}, user_metadata: {} }));
    });
    await new Promise<void>(resolve => auth.listen(0, '127.0.0.1', resolve));
    const address = auth.address();
    if (!address || typeof address === 'string')
        throw Error('Porta local inválida');
    const urlFor = (config: pg.ClientConfig) => { const url = new URL(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!); url.username = config.user!; url.password = String(config.password); return url.href; };
    const environment = () => ({ ...process.env, NODE_ENV: 'test', OWNER_USER_ID: owner, OWNER_SESSION_TOKEN: token, SUPABASE_URL: 'http://127.0.0.1:' + address.port, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', DATABASE_URL: urlFor(dst.apiConfig.database), DATABASE_TLS: 'disable-local', PRIVATE_RESTORE_DATABASE_URL: urlFor(dst.maintenance), PRIVATE_RESTORE_DATABASE_TLS: 'disable-local' });
    try {
        const files = await exportPrivateMain(['--private-dir', directory, '--format', 'both'], environment());
        const file = files.find(file => file.endsWith('.json'))!;
        const exported = await readPrivateSnapshot(file);
        await expect(restorePrivateMain(['preview', '--file', file], environment())).rejects.toThrow();
        await dst.db.close();
        await cleanFixture();
        dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, true);
        expect(await restorePrivateMain(['preview', '--file', file], environment())).toMatchObject({ state: 'preview' });
        await expect(restorePrivate({ database: dst.maintenance, ownerId: owner, actor: dst.actor, snapshot: exported, mode: 'apply', chunkSize: 1, afterChunk: async () => { throw Error('morte sintética antes de informar o ID'); } })).rejects.toThrow();
        // CLI redescobre a execução ativa sem receber run-id nem inspecionar o banco.
        const applied = await restorePrivateMain(['apply', '--file', file], environment());
        expect(applied.state).toBe('completed');
        expect(await restorePrivateMain(['apply', '--file', file], environment())).toEqual(applied);
        expect(await restorePrivateMain(['resume', '--file', file, '--run-id', applied.runId!], environment())).toEqual(applied);
        const restored = await createExportService(dst.db).json(dst.actor);
        expect(restored.entities.filter(row => !(row.table === 'audit_log' && row.data.id === applied.runId))).toEqual(exported.entities);
        const env = environment();
        const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/export-private.ts', '--private-dir', directory, '--format', 'json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => { output += String(chunk); });
        child.stderr.on('data', chunk => { output += String(chunk); });
        const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
        expect(exit).toBe(0);
        expect(output).toContain('Exportação privada concluída');
        expect(output).not.toContain(String(dst.maintenance.password));
        expect(output).not.toContain(String(dst.apiConfig.database.password));
        expect(output).not.toContain(token);
        expect(verified).toBeGreaterThanOrEqual(6);
    }
    finally {
        await dst.db.close();
        await new Promise<void>((resolve, reject) => auth.close(error => error ? reject(error) : resolve()));
        await removePrivateTestDirectory(directory);
    }
});
async function removePrivateTestDirectory(directory: string) {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Destino temporário inválido');
    await rm(directory, { recursive: true, force: true });
}
it('exige reatribuição explícita ao proprietário configurado e preserva a proveniência da origem', async () => {
    const dst = await runtime(process.env.LOCAL_RESTORE_TEST_DATABASE_URL!, true);
    const originalOwner = randomUUID();
    const audit = { formatVersion: 1 as const, table: 'audit_log' as const, data: { id: randomUUID(), actor: { kind: 'owner' as const, id: originalOwner }, source: 'fixture', occurredAt: time, entityType: 'owner_settings', entityId: randomUUID(), operation: 'insert', beforeData: null, afterData: { owner_id: originalOwner }, diff: {}, requestId: randomUUID(), createdAt: time } };
    const snapshot = buildSnapshot(originalOwner, [...settingsSnapshot().entities, audit], time, emptyContinuity);
    const options = { database: dst.maintenance, ownerId: owner, actor: dst.actor, snapshot, mode: 'apply' as const };
    try {
        await expect(restorePrivate(options)).rejects.toThrow();
        await expect(restorePrivate({ ...options, reassignOwner: originalOwner })).rejects.toThrow();
        await expect(restorePrivate({ ...options, actor: { ...dst.actor }, reassignOwner: owner })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        const result = await restorePrivate({ ...options, reassignOwner: owner });
        const exported = await createExportService(dst.db).json(dst.actor);
        expect(exported.entities.find(row => row.table === 'audit_log' && row.data.id === audit.data.id)).toEqual(audit);
        expect(exported.entities.find(row => row.table === 'audit_log' && row.data.id === result.runId)).toMatchObject({ data: { afterData: { sourceOwnerId: originalOwner, destinationOwnerId: owner } } });
    }
    finally { await dst.db.close(); }
});
