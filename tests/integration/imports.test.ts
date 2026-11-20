import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authenticateBearer } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase } from '../../server/database';
import { createImportService } from '../../server/services/imports';
import { createApplicationService } from '../../server/services/applications';
import { provisionOwner } from '../../scripts/provision-owner';
import { connectTestDatabase } from '../helpers/database';
import { LEGACY_HEADER, IMPORTER_VERSION, PARSER_VERSION, parseLegacyCsv, sha256 } from '../../domain/import';
import { unknownDate } from '../fixtures/career';
import type { DateValue } from '../../shared/model';
import { loadAppliedImportStates } from '../../server/repositories/transfers';
import { canonicalJson } from '../../domain/export';
import { reconcileCutoverFiles } from '../../scripts/cutover-check';
import { createLegacyPreview } from '../../scripts/import-legacy';
import { syntheticCareerApi } from '../helpers/synthetic-career';

const owner = randomUUID(); const cycleId = randomUUID();
function source(rows: string[][], markdown = '\ufeff# Revisão fictícia\r\nTexto preservado.\r\n') {
  const bytes = Buffer.from(LEGACY_HEADER.join(',') + '\r\n' + rows.map((row) => row.map((v) => '"' + v.replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n');
  const parsed = parseLegacyCsv(bytes); const instant = new Date().toISOString();
  const sources = [{ name: 'controle.csv', bytes }, { name: 'revisao.md', bytes: Buffer.from(markdown) }];
  const descriptions = sources.map(({ name, bytes: content }) => ({ name, sourcePath: 'ignored/client/path/' + name, snapshotPath: 'sources/' + name, sha256: sha256(content), size: content.length, ids: name.endsWith('.csv') ? rows.map((row) => row[0]!) : [], rowCount: name.endsWith('.csv') ? rows.length : 0, readAt: instant }));
  return { manifest: { formatVersion: 2, mode: 'preview', importerVersion: IMPORTER_VERSION, parserVersion: PARSER_VERSION, sourceSetHash: sha256(JSON.stringify({ importer: IMPORTER_VERSION, parser: PARSER_VERSION, sources: descriptions.map(({ name, sha256: hash }) => ({ name, sha256: hash })) })), startedAt: instant, completedAt: instant, snapshotDirectory: 'ignored/client/path', writerFreeze: false, requiresSourceRecheckBeforeApply: true, sources: descriptions, parsed, comparison: { mode: 'source_only', basis: [] }, diff: parsed.rows.map((row) => ({ legacyId: row.legacyId, kind: 'new' })) }, sources: sources.map(({ name, bytes: content }) => ({ name, bytesBase64: content.toString('base64') })), cycle: { id: cycleId, expectedVersion: null, resetDate: unknownDate, resetMarker: 'reinício fictício', isCurrent: true } };
}
const row = (id: number, order = '') => [`V${700 + id}`, 'Empresa inventada', 'Engenharia', 'literal desconhecido', 'JOB-SYNTH', '', 'https://example.test/job?raw=1', 'C:\\curriculos\\ficcional.pdf', 'confirmado', '', 'Relato de envio fictício', 'CV A | CV B', 'Narrativa sem data', order, 'fonte literal', 'nota fonte', '2020-02-03'];
const interpretation = { track: null, applicationInstance: 'initial', cycleRelation: 'unknown', kind: 'desconhecido', provider: null, tenant: null };
const allDecisions = () => Object.fromEntries(LEGACY_HEADER.map((name) => [name, name === 'observacoes' ? 'current' : 'source']));

it('reconciles a native skip receipt whose reply is newer than its applied baseline', async () => {
  const api = await syntheticCareerApi();
  const directory = await mkdtemp(path.join(tmpdir(), 'career-native-cutover-'));
  const sourceDir = path.join(directory, 'source'), privateDir = path.join(directory, 'private');
  const post = (unit: string, data: unknown) => api.request('/api/v1/imports/apply', {
    method: 'POST', headers: { ...api.headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ unit, data }),
  });
  const cycle = { id: randomUUID(), expectedVersion: null as number | null, resetDate: unknownDate, resetMarker: null, isCurrent: true };
  async function prepareRun(addBom: boolean) {
    const file = source([row(1)]).sources[0]!;
    const original = Buffer.from(file.bytesBase64, 'base64');
    // Muda o hash do arquivo sem mudar os bytes da linha nem exigir uma revisão legada.
    const bytes = addBom ? Buffer.concat([Buffer.from('\ufeff'), original]) : original;
    const sources = [{ name: file.name, bytesBase64: bytes.toString('base64') }];
    await writeFile(path.join(sourceDir, file.name), bytes);
    const preview = await createLegacyPreview({ sourceDir, privateDir, files: [file.name] });
    const prepared = await post('prepare', { manifest: preview.manifest, sources, cycle });
    expect(prepared.status).toBe(200);
    return { runId: prepared.json.runId, manifestFile: path.join(preview.directory, 'manifest.json') };
  }
  const applyRow = (runId: string) => post('application', { runId, legacyId: 'V701', expectedVersion: null, expectedOpportunityVersion: null, interpretation, decisions: null });
  try {
    await mkdir(sourceDir);
    await mkdir(privateDir);
    const initial = await prepareRun(false);
    const applied = await applyRow(initial.runId);
    expect(applied.status).toBe(200);
    const { applicationId } = applied.json;
    expect((await post('complete', { runId: initial.runId, reviewRequired: false })).status).toBe(200);
    expect((await api.post({ operation: 'archive_application', application: { id: applicationId, expectedVersion: 1 } })).status).toBe(200);
    cycle.expectedVersion = 1;
    const current = await prepareRun(true);
    const skipped = await applyRow(current.runId);
    expect(skipped.status).toBe(200);
    expect(skipped.json).toEqual({ applicationId, version: 2, result: 'skipped' });
    expect((await post('complete', { runId: current.runId, reviewRequired: false })).status).toBe(200);
    const exported = await api.request('/api/v1/exports?format=json', { headers: api.headers });
    expect(exported.status).toBe(200);
    const exportFile = path.join(privateDir, 'export.json');
    await writeFile(exportFile, canonicalJson(exported.json));
    expect(await reconcileCutoverFiles(current.manifestFile, exportFile)).toMatchObject({
      exitCode: 0, counts: { registros_verificados: 1, reaplicacoes_com_baseline: 1, registros_com_versao_posterior: 1 }, discrepancies: {},
    });
  } finally {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('importação legada com autorização, unidades atômicas e retomada', () => {
  let admin: pg.Client; let database: ReturnType<typeof createDatabase>; let service: ReturnType<typeof createImportService>; let actor: Awaited<ReturnType<typeof authenticateBearer>>;
  beforeAll(async () => {
    admin = await connectTestDatabase(); const password = randomBytes(32).toString('base64url');
    await provisionOwner({ adminUrl: process.env.LOCAL_TEST_DATABASE_URL, ownerId: owner, apiPassword: password, restorePassword: randomBytes(32).toString('base64url') });
    const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!); url.username = 'career_api'; url.password = password;
    const config = readServerConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_TLS: 'disable-local', OWNER_USER_ID: owner, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
    database = createDatabase(config); service = createImportService(database);
    actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, { getUser: async () => ({ data: { user: { id: owner } }, error: null }) });
  });
  afterAll(async () => {
    await database?.close();
    if (admin) {
      await admin.query('BEGIN'); await admin.query("SET LOCAL session_replication_role='replica'");
      for (const table of ['mutation_keys', 'creation_requests', 'review_versions', 'batch_members', 'batches', 'import_rows', 'source_files', 'import_runs', 'cycles', 'application_resumes', 'links', 'events', 'evidence', 'resume_refs', 'applications', 'opportunity_identities', 'opportunities', 'owner_settings', 'audit_log', 'maintenance_state', 'owner_config']) await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
      await admin.query('COMMIT'); await admin.end();
    }
  });
  async function prepare(input = source([row(1)])) {
    const cycle = (await admin.query('SELECT version FROM career.cycles WHERE owner_id=$1 AND id=$2', [owner, cycleId])).rows[0];
    input.cycle.expectedVersion = cycle?.version ?? null;
    return service.prepare(actor, input);
  }
  const apply = (runId: unknown, legacyId: string, extra = {}) => service.applyApplication(actor, { runId, legacyId, expectedVersion: null, expectedOpportunityVersion: null, interpretation, decisions: null, ...extra });

  it('reaplica bytes idênticos sem duplicar IDs, eventos nem auditoria', async () => {
    const input = source([row(1)]); const run = await prepare(input); const first = await apply(run.runId, 'V701');
    const count = (await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows;
    expect(await apply(run.runId, 'V701')).toEqual(first);
    expect(await prepare(input)).toEqual(run);
    await expect(prepare({ ...input, cycle: { ...input.cycle, isCurrent: false } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows).toEqual(count);
    const stored = (await admin.query('SELECT * FROM career.applications WHERE id=$1', [first.applicationId])).rows[0];
    expect(stored).toMatchObject({ legacy_id: 'V701', display_id: 'V701', submitted_date: unknownDate, legacy_resume_text: 'CV A | CV B', legacy_registered_date: { precision: 'day', certainty: 'exact', value: '2020-02-03' }, stage: 'desconhecida', discovery_channel: null, submission_platform: null });
    expect((await admin.query('SELECT original_bytes FROM career.source_files WHERE import_run_id=$1 AND file_name=$2', [run.runId, 'controle.csv'])).rows[0].original_bytes).toEqual(Buffer.from(input.sources[0]!.bytesBase64, 'base64'));
    expect((await admin.query('SELECT original_text FROM career.source_files WHERE import_run_id=$1 AND file_name=$2', [run.runId, 'revisao.md'])).rows[0].original_text).toBe(Buffer.from(input.sources[1]!.bytesBase64, 'base64').toString('utf8'));
    expect((await admin.query('SELECT count(*) FROM career.events WHERE application_id=$1 AND kind=\'envio_confirmado\'', [first.applicationId])).rows[0].count).toBe('1');
    expect((await admin.query('SELECT original_url FROM career.links WHERE application_id=$1 ORDER BY original_url', [first.applicationId])).rows.map((v) => v.original_url)).toEqual(['C:\\curriculos\\ficcional.pdf', 'https://example.test/job?raw=1']);
  });
  it('mantém baseline aplicado após skip e exige decisões por campo com versões atuais', async () => {
    const firstRun = await prepare(); const first = await apply(firstRun.runId, 'V701');
    await createApplicationService(database)(actor, { idempotencyKey: randomUUID(), command: { operation: 'update_application', application: { id: first.applicationId, expectedVersion: 1 }, changes: { notes: 'edição humana', track: 'Trilha humana' }, affectedBatches: [] } });
    const metadata = await prepare(source([row(1)], '# Outro metadado fictício')); const skipped = await apply(metadata.runId, 'V701');
    expect(skipped).toEqual({ applicationId: first.applicationId, version: 2, result: 'skipped' });
    const retained = (await admin.query(`SELECT r.applied_target_version, r.unit_result, a.after_data->'unit_result' AS audited
      FROM career.import_rows r JOIN career.source_files f ON f.owner_id=r.owner_id AND f.id=r.source_file_id
      JOIN career.audit_log a ON a.owner_id=r.owner_id AND a.entity_type='import_rows' AND a.entity_id=r.id AND a.operation='insert'
      WHERE f.import_run_id=$1`, [metadata.runId])).rows;
    expect(retained).toEqual([{ applied_target_version: 1, unit_result: skipped, audited: skipped }]);
    const changedRow = row(1); changedRow[15] = 'edição na fonte'; const changed = await prepare(source([changedRow]));
    expect(await service.preview(actor, { runId: changed.runId })).toMatchObject({ diff: [{ legacyId: 'V701', kind: 'conflict' }] });
    await expect(apply(changed.runId, 'V701')).rejects.toMatchObject({ code: 'CONFLICT' });
    const op = (await admin.query('SELECT o.version FROM career.applications a JOIN career.opportunities o ON o.id=a.opportunity_id WHERE a.id=$1', [first.applicationId])).rows[0];
    await expect(apply(changed.runId, 'V701', { expectedVersion: 1, expectedOpportunityVersion: op.version, decisions: allDecisions() })).rejects.toMatchObject({ code: 'CONFLICT' });
    const applied = await apply(changed.runId, 'V701', { expectedVersion: 2, expectedOpportunityVersion: op.version, decisions: allDecisions(), interpretation: { ...interpretation, track: 'Trilha humana' } });
    expect(applied.applicationId).toBe(first.applicationId);
    expect((await admin.query('SELECT notes FROM career.applications WHERE id=$1', [first.applicationId])).rows[0].notes).toBe('edição humana');
    expect((await admin.query('SELECT track FROM career.applications WHERE id=$1', [first.applicationId])).rows[0].track).toBe('Trilha humana');
    const ledger = (await admin.query('SELECT original_text,applied_target_version FROM career.import_rows WHERE target_application_id=$1 ORDER BY created_at', [first.applicationId])).rows;
    expect(ledger.map((v) => v.applied_target_version)).toEqual([1, 1, 3]); expect(ledger.at(-1).original_text).toContain('edição na fonte');
  });
  it('seleciona o último estado aplicado quando a transação mais antiga aplica por último', async () => {
    const initial = row(350); initial[15] = 'Estado A fictício'; const firstRun = await prepare(source([initial])); const app = await apply(firstRun.runId, initial[0]!);
    const sourceB = [...initial]; sourceB[15] = 'Estado B fictício'; const runB = await prepare(source([sourceB]));
    const sourceC = [...initial]; sourceC[15] = 'Estado C fictício'; const runC = await prepare(source([sourceC]));
    let entered!: () => void; let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = createImportService({ ...database, transaction: (who, work, context) => database.transaction(who, async (tx) => work({ ...tx, query: async (sql, values) => {
      if (sql.startsWith('SELECT pg_advisory_xact_lock(hashtextextended')) { entered(); await gate; } return tx.query(sql, values);
    } }), context) });
    const decisions = allDecisions(); decisions.observacoes = 'source';
    const pending = delayed.applyApplication(actor, { runId: runC.runId, legacyId: initial[0], expectedVersion: 2, expectedOpportunityVersion: 2, interpretation, decisions });
    await reached;
    try { await apply(runB.runId, initial[0]!, { expectedVersion: 1, expectedOpportunityVersion: 1, decisions }); } finally { release(); }
    expect((await pending).version).toBe(3);
    const selected = (await database.transaction(actor, (tx) => loadAppliedImportStates(tx, owner))).find((state) => state.legacyId === initial[0]);
    expect(selected).toMatchObject({ importedApplicationVersion: 3, rawRowHash: source([sourceC]).manifest.parsed.rows[0]!.rawRowHash, originalText: source([sourceC]).manifest.parsed.rows[0]!.raw, resolution: { request: { expectedVersion: 2, expectedOpportunityVersion: 2 }, appliedInterpretation: interpretation } });
    expect((await admin.query('SELECT applied_target_version FROM career.import_rows WHERE target_application_id=$1 ORDER BY created_at,id', [app.applicationId])).rows.map((v) => v.applied_target_version)).toEqual([1, 3, 2]);
    expect(await service.preview(actor, { runId: runC.runId })).toMatchObject({ diff: expect.arrayContaining([{ legacyId: initial[0], kind: 'unchanged' }]) });
    const metadata = await prepare(source([sourceC], '# Metadado do último estado aplicado'));
    expect((await apply(metadata.runId, initial[0]!)).result).toBe('skipped');
    expect((await admin.query('SELECT applied_target_version,original_text FROM career.import_rows WHERE source_file_id IN(SELECT id FROM career.source_files WHERE import_run_id=$1)', [metadata.runId])).rows).toEqual([{ applied_target_version: 3, original_text: source([sourceC]).manifest.parsed.rows[0]!.raw }]);
  });
  it.each([{ sourceOrder: '', fixtureId: 400 }, { sourceOrder: '999999', fixtureId: 401 }])('preserva ordem atribuída pelo runtime ao escolher current contra ordem fonte "$sourceOrder"', async ({ sourceOrder, fixtureId }) => {
    const initial = row(fixtureId); const firstRun = await prepare(source([initial])); const app = await apply(firstRun.runId, initial[0]!);
    await createApplicationService(database)(actor, { idempotencyKey: randomUUID(), command: { operation: 'update_application', application: { id: app.applicationId, expectedVersion: 1 }, changes: {}, reconciliation: { submittedDate: unknownDate, cycleRelation: 'after_reset' }, affectedBatches: [], evidence: { clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Reconciliação fictícia com alocação explícita.', source: null, occurredDate: unknownDate, privateRef: null, localRef: null } } });
    const ordered = (await admin.query('SELECT cycle_order FROM career.applications WHERE id=$1', [app.applicationId])).rows[0];
    const batches = (await admin.query('SELECT b.id,b.version FROM career.batches b JOIN career.batch_members m ON m.owner_id=b.owner_id AND m.batch_id=b.id WHERE m.application_id=$1', [app.applicationId])).rows.map((v) => ({ id: v.id, expectedVersion: v.version }));
    const counter = (await admin.query('SELECT next_order FROM career.cycles WHERE id=$1', [cycleId])).rows[0].next_order;
    const changed = [...initial]; changed[13] = sourceOrder; changed[15] = 'Nota da fonte alterada'; const input = source([changed]); const next = await prepare(input);
    const decisions = allDecisions(); decisions.observacoes = 'source';
    const command = { expectedVersion: 2, expectedOpportunityVersion: 1, interpretation: { ...interpretation, cycleRelation: 'after_reset' }, decisions, affectedBatches: batches };
    await expect(apply(next.runId, initial[0]!, command)).rejects.toMatchObject({ code: 'CONFLICT' });
    decisions.ordem_ciclo = 'current'; await apply(next.runId, initial[0]!, command);
    expect((await admin.query('SELECT cycle_order,notes FROM career.applications WHERE id=$1', [app.applicationId])).rows[0]).toEqual({ cycle_order: ordered.cycle_order, notes: changed[15] });
    expect((await admin.query('SELECT next_order FROM career.cycles WHERE id=$1', [cycleId])).rows[0].next_order).toBe(counter);
    expect((await admin.query('SELECT original_text FROM career.import_rows WHERE source_file_id IN(SELECT id FROM career.source_files WHERE import_run_id=$1)', [next.runId])).rows[0].original_text).toBe(input.manifest.parsed.rows[0]!.raw);
  });
  it('nega reconciliação de fonte alterada sobre alias mesclado e mantém replay antigo estável', async () => {
    const aliasRow = row(410); const canonicalRow = row(411); const firstRun = await prepare(source([aliasRow, canonicalRow]));
    const alias = await apply(firstRun.runId, aliasRow[0]!); const canonical = await apply(firstRun.runId, canonicalRow[0]!);
    await createApplicationService(database)(actor, { idempotencyKey: randomUUID(), command: { operation: 'resolve_duplicate', application: { id: alias.applicationId, expectedVersion: 1 }, canonicalApplication: { id: canonical.applicationId, expectedVersion: 1 }, affectedBatches: [], reason: 'Duplicata fictícia revisada.', evidence: { clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Evidência fictícia da duplicata.', source: null, occurredDate: unknownDate, privateRef: null, localRef: null } } });
    const changed = [...aliasRow]; changed[15] = 'Mutação que deve ser rejeitada'; const next = await prepare(source([changed]));
    const inventory = async () => ({ applications: (await admin.query('SELECT * FROM career.applications WHERE id=ANY($1::uuid[]) ORDER BY id', [[alias.applicationId, canonical.applicationId]])).rows, opportunities: (await admin.query('SELECT o.* FROM career.opportunities o JOIN career.applications a ON a.owner_id=o.owner_id AND a.opportunity_id=o.id WHERE a.id=ANY($1::uuid[]) ORDER BY o.id', [[alias.applicationId, canonical.applicationId]])).rows, events: (await admin.query('SELECT * FROM career.events WHERE application_id=ANY($1::uuid[]) ORDER BY id', [[alias.applicationId, canonical.applicationId]])).rows, audits: (await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows });
    const before = await inventory(); const decisions = allDecisions(); decisions.observacoes = 'source';
    await expect(apply(next.runId, aliasRow[0]!, { expectedVersion: 2, expectedOpportunityVersion: 1, decisions })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await apply(firstRun.runId, aliasRow[0]!)).toEqual(alias); expect(await inventory()).toEqual(before);
    expect((await admin.query('SELECT id FROM career.import_rows WHERE source_file_id IN(SELECT id FROM career.source_files WHERE import_run_id=$1)', [next.runId])).rowCount).toBe(0);
  });
  it('rejeita hashes incorretos e ator forjado sem abrir caminhos do cliente', async () => {
    const forged = source([row(2)]); forged.sources[0]!.bytesBase64 = Buffer.from('outros bytes').toString('base64');
    await expect(prepare(forged)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.prepare({ ...actor } as typeof actor, source([row(2)]))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.prepare(actor, { ...source([row(2)]), actorKind: 'import' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('retoma unidades confirmadas e reverte candidatura/evidência/evento/auditoria na unidade interrompida', async () => {
    const run = await prepare(source([row(3), row(4)])); const first = await apply(run.runId, 'V703');
    const before = (await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows;
    const failing = createImportService({ ...database, transaction: (who, work, context) => database.transaction(who, async (tx) => work({ ...tx, query: async (sql, values) => {
      if (sql.startsWith('INSERT INTO career.import_rows')) throw new Error('interrupção sintética sem dados');
      return tx.query(sql, values);
    } }), context) });
    await expect(failing.applyApplication(actor, { runId: run.runId, legacyId: 'V704', expectedVersion: null, expectedOpportunityVersion: null, interpretation, decisions: null })).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect((await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows).toEqual(before);
    expect((await admin.query('SELECT id FROM career.applications WHERE owner_id=$1 AND legacy_id=\'V704\'', [owner])).rowCount).toBe(0);
    expect(await apply(run.runId, 'V703')).toEqual(first); expect((await apply(run.runId, 'V704')).result).toBe('imported');
  });
  it('compartilha identidade forte, mantém trilhas distintas e sinaliza identidade desconhecida', async () => {
    const run = await prepare(source([row(5), row(6), row(7)]));
    const resolved = { ...interpretation, provider: 'portal fictício', tenant: 'tenant-synth', track: 'Track A' };
    const a = await apply(run.runId, 'V705', { interpretation: resolved });
    const b = await apply(run.runId, 'V706', { interpretation: { ...resolved, track: 'Track B' } });
    const apps = (await admin.query('SELECT opportunity_id FROM career.applications WHERE id=ANY($1::uuid[])', [[a.applicationId, b.applicationId]])).rows;
    expect(apps[0].opportunity_id).toBe(apps[1].opportunity_id);
    const runtime = await createApplicationService(database)(actor, { idempotencyKey: randomUUID(), command: { operation: 'save_application', clientId: randomUUID(), data: { opportunity: { company: 'Outra descrição fictícia', title: 'Título novo', platform: resolved.provider, tenant: resolved.tenant, jobCode: 'JOB-SYNTH', jobKey: null, kind: 'vaga', seniority: null, modality: null, description: null, stack: [], identities: [] }, track: resolved.track, applicationInstance: 'initial', submissionStatus: 'nao_confirmado', submittedDate: unknownDate, stage: 'desconhecida', cycleRelation: 'unknown', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [], links: [] }, evidence: null } });
    expect(runtime.body.application?.id).toBe(a.applicationId); expect(runtime.body.existing).toBe(true);
    await expect(apply(run.runId, 'V707', { interpretation: resolved })).rejects.toMatchObject({ code: 'CONFLICT' });
    const c = await apply(run.runId, 'V707');
    expect((await admin.query('SELECT opportunity_id FROM career.applications WHERE id=$1', [c.applicationId])).rows[0].opportunity_id).not.toBe(apps[0].opportunity_id);
    const ledger = (await admin.query('SELECT pending_issues FROM career.import_rows WHERE target_application_id=$1', [c.applicationId])).rows[0];
    expect(ledger.pending_issues).toContain('unresolved_identity');
  });
  it('respeita escolhas de links/identidade e registra confirmação efetiva sem inferir etapa', async () => {
    const data = row(50, '50'); data[8] = 'nao_confirmado';
    const run = await prepare(source([data])); const original = await apply(run.runId, 'V750', { interpretation: { ...interpretation, cycleRelation: 'before_reset' } });
    const changed = [...data]; changed[8] = 'confirmado'; changed[4] = 'OUTRO-CODIGO'; changed[6] = 'https://example.test/novo'; changed[12] = 'entrevista concluída, sem inferência';
    const next = await prepare(source([changed])); const decisions = allDecisions();
    await expect(apply(next.runId, 'V750', { expectedVersion: 1, expectedOpportunityVersion: 1, decisions, interpretation: { ...interpretation, cycleRelation: 'before_reset' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    decisions.codigo_vaga = 'current'; decisions.url_original = 'current'; decisions.etapa = 'current'; decisions.evidencia_envio = 'current'; decisions.fonte = 'current';
    const command = { expectedVersion: 1, expectedOpportunityVersion: 1, decisions, interpretation: { ...interpretation, cycleRelation: 'before_reset' } };
    await expect(apply(next.runId, 'V750', { ...command, interpretation: { ...command.interpretation, kind: 'pipeline' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await apply(next.runId, 'V750', command);
    expect((await admin.query("SELECT count(*) FROM career.events WHERE application_id=$1 AND kind='envio_confirmado'", [original.applicationId])).rows[0].count).toBe('1');
    expect((await admin.query("SELECT e.result_text,e.source_text,v.source FROM career.events e JOIN career.evidence v ON v.id=e.evidence_id WHERE e.application_id=$1 AND e.kind='envio_confirmado'", [original.applicationId])).rows[0]).toEqual({ result_text: null, source_text: null, source: null });
    expect((await admin.query('SELECT original_url FROM career.links WHERE application_id=$1', [original.applicationId])).rows.map((v) => v.original_url)).not.toContain('https://example.test/novo');
    expect((await admin.query('SELECT stage,cycle_relation,cycle_order FROM career.applications WHERE id=$1', [original.applicationId])).rows[0]).toMatchObject({ stage: 'desconhecida', cycle_relation: 'before_reset', cycle_order: '50' });
    expect((await admin.query('SELECT next_order FROM career.cycles WHERE id=$1', [cycleId])).rows[0].next_order).toBe('51');
  });
  const reconciledDates: DateValue[] = [unknownDate, { precision: 'day', certainty: 'exact', value: '2020-03-12' }, { precision: 'month', certainty: 'approximate', value: '2019-11' }, { precision: 'year', certainty: 'exact', value: '2018' }, { precision: 'instant', certainty: 'approximate', value: '2017-06-07T08:09:10-03:00' }];
  it.each(reconciledDates.map((date, index) => ({ date, index, precision: date.precision })))('confirma com a data atual $precision e preserva a fonte rejeitada sem duplicar o evento', async ({ date, index }) => {
    const originalRow = row(210 + index); originalRow[8] = 'nao_confirmado'; const firstRun = await prepare(source([originalRow]));
    const original = await apply(firstRun.runId, originalRow[0]!);
    await createApplicationService(database)(actor, { idempotencyKey: randomUUID(), command: { operation: 'update_application', application: { id: original.applicationId, expectedVersion: 1 }, changes: {}, reconciliation: { submittedDate: date, cycleRelation: 'unknown' }, affectedBatches: [], evidence: { clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Data atual revisada em cenário fictício.', source: null, occurredDate: unknownDate, privateRef: null, localRef: null } } });
    const changedRow = [...originalRow]; changedRow[8] = 'confirmado'; changedRow[9] = '2020-05-01'; const input = source([changedRow]); const nextRun = await prepare(input);
    const decisions = allDecisions(); decisions.data_envio = 'current'; const command = { expectedVersion: 2, expectedOpportunityVersion: 1, decisions };
    const result = await apply(nextRun.runId, originalRow[0]!, command);
    const app = (await admin.query('SELECT submission_status,submitted_date FROM career.applications WHERE id=$1', [original.applicationId])).rows[0];
    expect(app).toEqual({ submission_status: 'confirmado', submitted_date: date });
    const events = (await admin.query("SELECT e.occurred_date,v.original_text FROM career.events e JOIN career.evidence v ON v.id=e.evidence_id WHERE e.application_id=$1 AND e.kind='envio_confirmado'", [original.applicationId])).rows;
    expect(events).toEqual([{ occurred_date: date, original_text: input.manifest.parsed.rows[0]!.raw }]);
    expect((await admin.query('SELECT original_text FROM career.import_rows WHERE target_application_id=$1 AND source_file_id IN(SELECT id FROM career.source_files WHERE import_run_id=$2)', [original.applicationId, nextRun.runId])).rows[0].original_text).toBe(input.manifest.parsed.rows[0]!.raw);
    expect((await admin.query("SELECT original_bytes FROM career.source_files WHERE import_run_id=$1 AND file_name='controle.csv'", [nextRun.runId])).rows[0].original_bytes).toEqual(Buffer.from(input.sources[0]!.bytesBase64, 'base64'));
    const audit = (await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows;
    expect(await apply(nextRun.runId, originalRow[0]!, command)).toEqual(result);
    expect((await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows).toEqual(audit);
    expect((await admin.query("SELECT count(*) FROM career.events WHERE application_id=$1 AND kind='envio_confirmado'", [original.applicationId])).rows[0].count).toBe('1');
  });
  it('só conclui depois das unidades declaradas e mantém resultado estável no retry', async () => {
    const run = await prepare(source([row(60), row(61)]));
    await apply(run.runId, 'V760');
    await expect(service.complete(actor, { runId: run.runId, reviewRequired: false })).rejects.toMatchObject({ code: 'CONFLICT' });
    await apply(run.runId, 'V761');
    const completed = await service.complete(actor, { runId: run.runId, reviewRequired: false });
    const audit = (await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows;
    expect(await service.complete(actor, { runId: run.runId, reviewRequired: false })).toEqual(completed);
    expect((await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows).toEqual(audit);
    expect((await admin.query('SELECT status FROM career.import_runs WHERE id=$1', [run.runId])).rows[0].status).toBe('completed');
  });
  it('aceita somente interpretação revisada explícita de evento histórico com data/resultado desconhecidos', async () => {
    const data = row(80); data[12] = 'Teste concluído, segundo relato fictício'; const run = await prepare(source([data]));
    const event = { clientId: randomUUID(), kind: 'avaliacao', state: 'concluido', occurredDate: unknownDate, resultText: null, scoreValue: null, scoreUnit: null, sourceText: data[12] };
    const app = await apply(run.runId, 'V780', { historicalEvents: [event] });
    const result = (await admin.query("SELECT * FROM career.events WHERE application_id=$1 AND kind='avaliacao'", [app.applicationId])).rows;
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ state: 'concluido', occurred_date: unknownDate, result_text: null, score_value: null });
    expect((await admin.query('SELECT stage FROM career.applications WHERE id=$1', [app.applicationId])).rows[0].stage).toBe('desconhecida');
    const next = await prepare(source([data], '# Metadado novo e fictício'));
    await apply(next.runId, 'V780', { historicalEvents: [event] });
    expect((await admin.query("SELECT count(*) FROM career.events WHERE application_id=$1 AND kind='avaliacao'", [app.applicationId])).rows[0].count).toBe('1');
  });
  it('rejeita projeção acima do limite e mantém referências perigosas como texto inerte com pendência', async () => {
    const tooLong = row(90); tooLong[1] = 'x'.repeat(501); const blocked = await prepare(source([tooLong]));
    await expect(apply(blocked.runId, 'V790')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await admin.query("SELECT id FROM career.applications WHERE owner_id=$1 AND legacy_id='V790'", [owner])).rowCount).toBe(0);
    const unsafe = row(91); unsafe[6] = 'javascript:alert(1)'; unsafe[7] = 'texto sem URL'; const input = source([unsafe]); const run = await prepare(input);
    const app = await apply(run.runId, 'V791');
    expect((await admin.query('SELECT id FROM career.links WHERE application_id=$1', [app.applicationId])).rowCount).toBe(0);
    expect((await admin.query('SELECT original_text FROM career.evidence WHERE owner_id=$1 AND id IN(SELECT evidence_id FROM career.events WHERE application_id=$2)', [owner, app.applicationId])).rows[0].original_text).toBe(input.manifest.parsed.rows[0]!.raw);
    expect((await admin.query('SELECT pending_issues FROM career.import_rows WHERE target_application_id=$1', [app.applicationId])).rows[0].pending_issues).toContain('dangerous_reference');
  });
  it('importa 30 membros exatos e Markdown histórico numa unidade independente, sem inventar snapshot anterior', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(101 + i, String(101 + i))); const external = row(140);
    const input = source([...rows, external]); const run = await prepare(input);
    const members: { legacyId: string; capturedOrder: number; expectedVersion: number; applicationId: string }[] = [];
    for (const [index, data] of rows.entries()) {
      const app = await apply(run.runId, data[0]!, { interpretation: { ...interpretation, cycleRelation: 'after_reset' } });
      members.push({ legacyId: data[0]!, capturedOrder: 101 + index, expectedVersion: 1, applicationId: app.applicationId });
    }
    const outside = await apply(run.runId, external[0]!, { interpretation: { ...interpretation, cycleRelation: 'before_reset' } });
    const populationIds = members.map((v) => v.applicationId);
    const command = { runId: run.runId, batchNumber: 12, members: members.map((v) => ({ legacyId: v.legacyId, capturedOrder: v.capturedOrder, expectedVersion: v.expectedVersion })), markdownFile: 'revisao.md', closedAt: null, historicalClosedDate: { precision: 'day', certainty: 'exact', value: '2020-04-14' }, documentedUpdatedDate: { precision: 'day', certainty: 'exact', value: '2020-04-15' }, snapshotTimeMeaning: 'import_capture', snapshot: { schemaVersion: 1, asOf: new Date().toISOString(), period: null, populationIds, eventIds: [], metrics: {}, externalResultApplicationIds: [outside.applicationId], externalResultEventIds: [] }, pendingIssues: ['Cabeçalho contraditório preservado para revisão.'] };
    const missing = structuredClone(command); missing.members[0]!.legacyId = 'V99999';
    await expect(service.applyReview(actor, missing)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await admin.query('SELECT id FROM career.batches WHERE owner_id=$1 AND batch_number=12', [owner])).rowCount).toBe(0);
    const stale = structuredClone(command); stale.members[0]!.expectedVersion = 2;
    await expect(service.applyReview(actor, stale)).rejects.toMatchObject({ code: 'CONFLICT' });
    const before = (await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows;
    const interrupted = createImportService({ ...database, transaction: (who, work, context) => database.transaction(who, async (tx) => work({ ...tx, query: async (sql, values) => {
      if (sql.startsWith('INSERT INTO career.review_versions')) throw new Error('interrupção sintética da revisão'); return tx.query(sql, values);
    } }), context) });
    await expect(interrupted.applyReview(actor, command)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect((await admin.query('SELECT id FROM career.batches WHERE owner_id=$1 AND batch_number=12', [owner])).rowCount).toBe(0);
    expect((await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows).toEqual(before);
    const first = await service.applyReview(actor, command); const audit = (await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows;
    expect(await service.applyReview(actor, command)).toEqual(first);
    expect((await admin.query('SELECT count(*) FROM career.audit_log WHERE owner_id=$1', [owner])).rows).toEqual(audit);
    const review = (await admin.query('SELECT * FROM career.review_versions WHERE id=$1', [first.reviewId])).rows[0];
    expect(review.snapshot).toEqual(command.snapshot); expect(review.population_ids).toEqual(populationIds);
    expect(review.original_markdown).toBe(Buffer.from(input.sources[1]!.bytesBase64, 'base64').toString('utf8'));
    expect(review.import_provenance.documentedUpdatedDate).toEqual(command.documentedUpdatedDate);
    expect(review.import_provenance.historicalClosedDate).toEqual(command.historicalClosedDate);
    expect(review.import_provenance.snapshotTimeMeaning).toBe('import_capture'); expect(review.closed_at).toBeNull();
    expect((await admin.query('SELECT captured_order FROM career.batch_members WHERE batch_id=$1 ORDER BY captured_order', [first.batchId])).rows.map((v) => Number(v.captured_order))).toEqual(members.map((v) => v.capturedOrder));
    expect((await admin.query('SELECT next_order FROM career.cycles WHERE id=$1', [cycleId])).rows[0].next_order).toBe('131');
    expect((await admin.query('SELECT count(*) FROM career.batch_members WHERE application_id=$1', [outside.applicationId])).rows[0].count).toBe('0');
    const correctedRows = structuredClone([...rows, external]); correctedRows[0]![8] = 'nao_confirmado';
    const correctionRun = await prepare(source(correctedRows));
    const reconciliation = { expectedVersion: 1, expectedOpportunityVersion: 1, decisions: allDecisions(), interpretation: { ...interpretation, cycleRelation: 'after_reset' } };
    await expect(apply(correctionRun.runId, rows[0]![0]!, reconciliation)).rejects.toMatchObject({ code: 'CONFLICT' });
    await apply(correctionRun.runId, rows[0]![0]!, { ...reconciliation, affectedBatches: [{ id: first.batchId, expectedVersion: 2 }] });
    expect((await admin.query('SELECT snapshot FROM career.review_versions WHERE id=$1', [first.reviewId])).rows[0].snapshot).toEqual(command.snapshot);
    expect((await admin.query('SELECT rectification_pending FROM career.batches WHERE id=$1', [first.batchId])).rows[0].rectification_pending).toBe(true);
    expect((await admin.query('SELECT eligible FROM career.batch_members WHERE batch_id=$1 AND application_id=$2', [first.batchId, populationIds[0]])).rows[0].eligible).toBe(true);
  });
});
