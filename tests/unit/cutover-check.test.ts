import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { buildReviewSnapshot } from '../../domain/cycles';
import { buildSnapshot, canonicalJson, transferHash } from '../../domain/export';
import { IMPORTER_VERSION, LEGACY_HEADER, parseLegacyCsv, sha256 } from '../../domain/import';
import { createLegacyPreview, type PreviewManifest } from '../../scripts/import-legacy';
import { analyticsEventSchema, analyticsRowSchema } from '../../shared/analytics';
import { reviewSnapshotSchema, type TransferEntity } from '../../shared/transfer';

const instant = '2026-02-05T12:00:00.000Z';
const unknown = { precision: 'unknown', value: null } as const;
const day = { precision: 'day', certainty: 'exact', value: '2026-02-04' } as const;
const id = (number: number) => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const [ownerId, runId, cycleId, csvId, mdId, batchId, reviewId] = [1, 2, 3, 4, 5, 6, 7].map(id) as [string, string, string, string, string, string, string];
const base = (identifier: string, version = 1) => ({ id: identifier, version, createdAt: instant, updatedAt: instant });
type Table = TransferEntity['table'];
type Data<T extends Table> = Extract<TransferEntity, { table: T }>['data'];
const interpretation = { track: null, applicationInstance: 'ficticia', cycleRelation: 'after_reset', kind: 'desconhecido', provider: null, tenant: null } as const;
const markdown = '# Revisão fictícia\r\nTexto de origem.\r\n';
const archiveReference = 'Arquivo fictício no armário';
const longAttribution = 'Atribuição fictícia integral '.padEnd(642, 'á');
const sourceProjectionWarning = 'unprojected_source_attribution';
const temp: string[] = [];
afterEach(async () => {
  for (const directory of temp.splice(0)) await rm(directory, { force: true, recursive: true });
});

async function fixture(reviewRequired = false, { withArchiveReference = false, withLongSource = false, closedAt = null }:
  { withArchiveReference?: boolean; withLongSource?: boolean; closedAt?: string | null } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'career-cutover-'));
  temp.push(directory);
  const sourceDir = await mkdtemp(path.join(directory, 'source-'));
  const privateDir = await mkdtemp(path.join(directory, 'private-'));
  const count = reviewRequired ? 30 : 2;
  const rows = Array.from({ length: count }, (_, i) => [
    'V' + (800 + i), 'Empresa fictícia ' + i, 'Vaga fictícia ' + i, 'Plataforma fictícia', '', '',
    'https://example.test/positions/' + i, withArchiveReference && i === 0 ? archiveReference : 'https://example.test/alternate/' + i,
    i === 0 ? 'confirmado' : 'nao_confirmado', '', 'Evidência fictícia', ' CV fictício ',
    'Relato de etapa fictício', String(i + 1), withLongSource && i === 0 ? longAttribution : 'Fonte fictícia', ' Observação fictícia ', '2026-02-04',
  ]);
  const csv = LEGACY_HEADER.join(',') + '\r\n' + rows.map((row) => row.join(',')).join('\r\n') + '\r\n';
  await writeFile(path.join(sourceDir, 'ficticio.csv'), csv);
  if (reviewRequired) await writeFile(path.join(sourceDir, 'ficticio.md'), markdown);
  const { manifest, directory: snapshotDirectory } = await createLegacyPreview({
    sourceDir, privateDir, files: reviewRequired ? ['ficticio.csv', 'ficticio.md'] : ['ficticio.csv'],
  });
  // A conferência funciona mesmo sem acesso aos caminhos da origem operacional.
  await rm(sourceDir, { recursive: true });
  const manifestFile = path.join(snapshotDirectory, 'manifest.json');
  const exportFile = path.join(privateDir, 'export.json');
  const entities: TransferEntity[] = [];
  function add<T extends Table>(table: T, data: Data<T>): Data<T> {
    entities.push({ formatVersion: 1, table, data } as TransferEntity);
    return data;
  }
  const applications: Data<'applications'>[] = [];
  const importRows: Data<'import_rows'>[] = [];
  const events: Data<'events'>[] = [];
  const evidence: Data<'evidence'>[] = [];
  const links: Data<'links'>[][] = [];
  const archived = manifest.sources.map((source) => {
    const [identifier, text] = source.name.endsWith('.csv') ? [csvId, csv] : [mdId, markdown];
    return add('source_files', { ...base(identifier), importRunId: runId, fileName: source.name,
      fileHash: source.sha256, originalBytesBase64: Buffer.from(text).toString('base64'), originalText: text });
  });
  add('cycles', { ...base(cycleId), resetDate: unknown, resetMarker: null, nextOrder: count + 1, isCurrent: true });
  const members = [];
  for (const [index, row] of manifest.parsed.rows.entries()) {
    const applicationId = id(100 + (reviewRequired ? count - 1 - index : index));
    const opportunity = add('opportunities', { ...base(id(200 + index)), company: row.company, title: row.title,
      platform: row.legacyPlatform, tenant: null, jobCode: null, jobKey: null, kind: 'desconhecido',
      seniority: null, modality: null, description: null, stack: [] });
    applications.push(add('applications', { ...base(applicationId), opportunityId: opportunity.id,
      legacyId: row.legacyId, displayId: row.legacyId, track: null, applicationInstance: 'ficticia',
      submissionStatus: row.submissionStatus!, submittedDate: unknown, stage: 'desconhecida',
      discoveryChannel: null, submissionPlatform: null, notes: ' Observação fictícia ', cycleRelation: 'after_reset',
      cycleOrder: index + 1, countingEligible: true, archivedAt: null, canonicalApplicationId: null,
      legacyRegisteredDate: day, legacyResumeText: ' CV fictício ' }));
    const unitResult = { applicationId, version: 1, result: 'imported' };
    const onlyArchive = withArchiveReference && index === 0;
    const longSource = withLongSource && index === 0;
    const pendingIssues = [...manifest.parsed.issues.filter(({ row }) => row === index + 2).map(({ code }) => code), 'unresolved_identity'];
    if (onlyArchive) pendingIssues.push('unprojected_reference');
    if (longSource) pendingIssues.push(sourceProjectionWarning);
    importRows.push(add('import_rows', { ...base(id(300 + index)), sourceFileId: csvId, rowNumber: index + 2,
      rowHash: row.rawRowHash, originalText: row.raw, legacyId: row.legacyId, targetApplicationId: applicationId,
      result: 'imported', pendingIssues, appliedTargetVersion: 1,
      resolution: { request: { runId, legacyId: row.legacyId, expectedVersion: null, expectedOpportunityVersion: null,
        interpretation, decisions: null, historicalEvents: [], affectedBatches: [] }, appliedInterpretation: interpretation }, unitResult }));
    evidence.push(add('evidence', { ...base(id(400 + index)), kind: 'texto_legado', originalText: row.raw,
      source: longSource ? null : 'Fonte fictícia', occurredDate: unknown, capturedAt: instant, privateRef: null, localRef: null }));
    events.push(add('events', { ...base(id(500 + index)), kind: index === 0 ? 'envio_confirmado' : 'nota',
      state: 'informado', occurredDate: unknown, resultText: 'Relato de etapa fictício', scoreValue: null, scoreUnit: null,
      sourceText: 'Evidência fictícia', applicationId, evidenceId: evidence[index]!.id, supersedesEventId: null }));
    links.push(row.links.filter((link) => link.classification === 'web').map((link, linkIndex) => add('links', { ...base(id(600 + index * 2 + linkIndex)),
      originalUrl: link.originalText, comparisonUrl: null, kind: 'legado', isLocal: false, isPrivate: false,
      applicationId, opportunityId: null, contactId: null })));
    members.push({ legacyId: row.legacyId, capturedOrder: index + 1, expectedVersion: 1 });
  }
  let review: Data<'review_versions'> | undefined;
  let reviewUnit;
  if (reviewRequired) {
    add('batches', { ...base(batchId, 2), cycleId, batchNumber: 1, target: 30, status: 'closed', rectificationPending: false });
    for (const [i, application] of applications.entries()) add('batch_members', { ...base(id(900 + i)),
      batchId, applicationId: application.id, capturedOrder: i + 1, allocation: 'counted', eligible: true });
    const snapshot = { schemaVersion: 1 as const, asOf: closedAt ?? instant, period: null, populationIds: applications.map((a) => a.id), eventIds: [], metrics: {} };
    const metadata = { historicalClosedDate: day, documentedUpdatedDate: unknown, snapshotTimeMeaning: closedAt ? 'historical_instant' : 'import_capture', pendingIssues: [] };
    const request = { runId, batchNumber: 1, members, markdownFile: 'ficticio.md', closedAt, snapshot, ...metadata };
    reviewUnit = { requestHash: transferHash(request), result: { batchId, reviewId } };
    review = add('review_versions', { ...base(reviewId), batchId, snapshot, versionNumber: 1, type: 'original',
      populationIds: snapshot.populationIds, eventIds: [], narrative: markdown, decisions: [], predecessorId: null,
      calculationVersion: null, closedAt, reason: null, evidenceId: null, originalMarkdown: markdown,
      importProvenance: { ...metadata, runId, sourceFileId: mdId, sourceHash: archived[1]!.fileHash, importerVersion: IMPORTER_VERSION, importedAt: instant } });
  }
  const run = add('import_runs', { ...base(runId, 2), importerVersion: IMPORTER_VERSION, sourceSetHash: manifest.sourceSetHash,
    status: 'completed', pendingIssues: [...new Set(manifest.parsed.issues.map(({ code }) => code))], unitState: { cycleId,
      cycleConfig: { id: cycleId, resetDate: unknown, resetMarker: null, isCurrent: true },
      completed: { reviewRequired, runId, rowCount: count }, ...(reviewUnit ? { review: reviewUnit } : {}) } });
  const save = async () => writeFile(exportFile, canonicalJson(buildSnapshot(ownerId, entities, instant)) + '\n');
  return { manifest, manifestFile, exportFile, applications, importRows, events, evidence, archived, links, entities, review, run, save, add };
}

async function check(input: { manifestFile: string; exportFile: string }) {
  const { reconcileCutoverFiles } = await import('../../scripts/cutover-check');
  return reconcileCutoverFiles(input.manifestFile, input.exportFile);
}

it('confere os artefatos privados pela CLI, com ordem, textos e data desconhecida preservados', async () => {
  const input = await fixture();
  await input.save();
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/cutover-check.ts',
    '--manifest', input.manifestFile, '--export', input.exportFile], { encoding: 'utf8' });
  expect(stdout).toContain('PASS');
  expect(stdout).toContain('2 registros');
  for (const privateValue of ['V800', 'Empresa fictícia', 'example.test', input.manifestFile]) expect(stdout).not.toContain(privateValue);
});

it.each([
  ['identidade_original_divergente', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.applications[0]!.legacyId = 'V999';
    input.applications[0]!.displayId = 'V999';
  }],
  ['evidencia_original_divergente', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.evidence[0]!.originalText = 'Outro texto fictício.';
  }],
  ['data_desconhecida_divergente', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.applications[0]!.submittedDate = day;
  }],
  ['ordem_original_divergente', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.importRows[0]!.legacyId = 'V801';
  }],
  ['ordem_projetada_divergente', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.applications[0]!.cycleOrder = 999;
  }],
  ['cv_original_divergente', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.applications[0]!.legacyResumeText = 'Outro CV fictício.';
  }],
  ['referencia_original_divergente', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.links[0]![1]!.originalUrl = 'https://example.test/replacement';
  }],
  ['linha_ausente', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.entities.splice(input.entities.findIndex((entity) => entity.data === input.importRows[0]), 1);
  }],
  ['mapeamento_duplicado', (input: Awaited<ReturnType<typeof fixture>>) => {
    input.add('import_rows', { ...input.importRows[0]!, id: id(900) });
  }],
] as const)('sinaliza %s mesmo com hashes válidos do exportador', async (category, change) => {
  const input = await fixture();
  change(input);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { [category]: 1 } });
});

it('classifica registros criados no aplicativo fora do conjunto legado', async () => {
  const input = await fixture();
  input.add('applications', { ...input.applications[0]!, id: id(900), legacyId: null, displayId: 'N000001', cycleOrder: null });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { candidaturas_nativas: 1 }, discrepancies: {} });
});

function stageChange(input: Fixture) {
  const app = input.applications[0]!;
  app.stage = 'entrevista';
  app.version = 2;
  const requestId = id(907);
  const stageEvent = input.add('events', { ...input.events[0]!, id: id(908), kind: 'entrevista', resultText: null, sourceText: 'entrevista', evidenceId: null });
  const before = { id: app.id, owner_id: ownerId, stage: 'desconhecida', version: 1 };
  const appAudit = ownerAudit(input, requestId, 909, 'applications', app.id, 'update', before, { ...before, stage: 'entrevista', version: 2 });
  const eventAudit = ownerAudit(input, requestId, 910, 'events', stageEvent.id, 'insert', null, {
    id: stageEvent.id, owner_id: ownerId, application_id: app.id, kind: stageEvent.kind, state: stageEvent.state,
    evidence_id: stageEvent.evidenceId, occurred_date: stageEvent.occurredDate, result_text: stageEvent.resultText,
    source_text: stageEvent.sourceText, score_value: stageEvent.scoreValue, score_unit: stageEvent.scoreUnit, supersedes_event_id: stageEvent.supersedesEventId,
  });
  return { stageEvent, appAudit, eventAudit, before };
}

it('classifica uma mudança de etapa com auditoria na mesma candidatura', async () => {
  const input = await fixture();
  stageChange(input);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { alteracoes_de_etapa_auditadas: 1, registros_verificados: 2 } });
});

it.each(['evento', 'ator', 'versão'] as const)('retém a mudança de etapa com %s contraditório', async (alteration) => {
  const input = await fixture();
  const { stageEvent, appAudit, eventAudit, before } = stageChange(input);
  if (alteration === 'evento') stageEvent.kind = 'rejeicao';
  if (alteration === 'ator') {
    eventAudit.actor = { kind: 'agent', id: id(990) };
    eventAudit.source = 'agent';
  }
  if (alteration === 'versão') appAudit.beforeData = { ...before, version: 2 };
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { etapa_atual_sem_proveniencia: 1 } });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
type HistoricalJson = Data<'import_rows'>['resolution'];
type Resolution = { request: Record<string, HistoricalJson> & { historicalEvents: NonNullable<HistoricalJson>[] }; appliedInterpretation: typeof interpretation };
const resolutionOf = (row: Data<'import_rows'>) => row.resolution as Resolution;

function priorImport(input: Fixture, csv = input.archived[0]!.originalText!) {
  const priorRunId = id(911);
  const priorFileId = id(912);
  input.add('import_runs', { ...input.run, id: priorRunId, sourceSetHash: '1'.repeat(64), unitState: { cycleId,
    completed: { reviewRequired: false, runId: priorRunId, rowCount: 2 } } });
  input.add('source_files', { ...input.archived[0]!, id: priorFileId, importRunId: priorRunId,
    fileHash: sha256(csv), originalText: csv, originalBytesBase64: Buffer.from(csv).toString('base64') });
  return parseLegacyCsv(csv).rows.map((sourceRow, index) => {
    const row = input.importRows[index]!;
    const resolution = resolutionOf(row);
    return input.add('import_rows', { ...row, id: id(913 + index), sourceFileId: priorFileId, rowHash: sourceRow.rawRowHash,
      originalText: sourceRow.raw, resolution: { ...resolution, request: { ...resolution.request, runId: priorRunId } } });
  });
}

function skippedImport(input: Fixture) {
  const prior = priorImport(input);
  for (const row of input.importRows) {
    row.result = 'skipped';
    row.unitResult = { applicationId: row.targetApplicationId, version: 1, result: 'skipped' };
  }
  return prior;
}

it('usa a evidência original do baseline quando a importação atual pulou linhas iguais', async () => {
  const input = await fixture();
  skippedImport(input);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { reaplicacoes_com_baseline: 2 } });
});

it('confere atribuição longa inteira com aviso somente no baseline aplicado', async () => {
  const input = await fixture(false, { withLongSource: true });
  await input.save();
  const preservation = { exitCode: 0, counts: { atribuicoes_de_fonte_preservadas_no_original: 1 }, discrepancies: {} };
  expect(await check(input)).toMatchObject(preservation);
  const [baseline] = skippedImport(input);
  const skip = input.importRows[0]!;
  skip.pendingIssues = skip.pendingIssues.filter((code) => code !== sourceProjectionWarning);
  await input.save();
  expect(await check(input)).toMatchObject(preservation);
  baseline!.pendingIssues = skip.pendingIssues;
  await input.save();
  const result = await check(input);
  expect(result).toMatchObject({ exitCode: 2, discrepancies: { avisos_da_linha_divergentes: 1 } });
  expect(result.counts.atribuicoes_de_fonte_preservadas_no_original).toBeUndefined();
});

it.each([
  ['evidencia_original_divergente', (input: Fixture) => { input.evidence[0]!.originalText = null; }],
  ['evidencia_original_divergente', (input: Fixture) => { input.evidence[0]!.source = 'Fonte encurtada'; }],
  ['avisos_da_linha_divergentes', (input: Fixture) => {
    input.importRows[0]!.pendingIssues = input.importRows[0]!.pendingIssues.filter((code) => code !== sourceProjectionWarning);
  }],
] as const)('retém atribuição longa diante de %s', async (category, change) => {
  const input = await fixture(false, { withLongSource: true });
  change(input);
  await input.save();
  const result = await check(input);
  expect(result).toMatchObject({ exitCode: 2, discrepancies: { [category]: 1 } });
  expect(result.counts.atribuicoes_de_fonte_preservadas_no_original).toBeUndefined();
});

const historicalEvent = {
  clientId: id(930), kind: 'entrevista', state: 'informado', occurredDate: unknown, resultText: 'Histórico fictício',
  scoreValue: null, scoreUnit: null, sourceText: 'Registro de origem fictício',
} as const;

it('detecta evento histórico solicitado no skip que perdeu seu recibo e registro', async () => {
  const input = await fixture();
  skippedImport(input);
  resolutionOf(input.importRows[0]!).request.historicalEvents = [historicalEvent];
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { evento_historico_divergente: 1 } });
});

function importInsertAudit(input: Fixture, requestId: string, auditId: number, entityType: string, entityId: string,
  fields: Record<string, unknown>) {
  const afterData = structuredClone({ id: entityId, owner_id: ownerId, version: 1, created_at: instant, updated_at: instant, ...fields });
  const diff = Object.fromEntries(Object.entries(afterData).map(([key, after]) => [key, { before: null, after }]));
  input.add('audit_log', { id: id(auditId), requestId, actor: { kind: 'import', id: ownerId }, source: IMPORTER_VERSION,
    occurredAt: instant, entityType, entityId, operation: 'insert', beforeData: null, afterData, diff, createdAt: instant });
}

async function auditedHistoricalReplay() {
  const input = await fixture();
  const [prior] = skippedImport(input);
  const applied = prior!;
  const selected = input.importRows[0]!;
  resolutionOf(applied).request.historicalEvents = [historicalEvent];
  resolutionOf(selected).request.historicalEvents = [historicalEvent];
  const { clientId, ...fields } = historicalEvent;
  const applicationId = input.applications[0]!.id;
  const event = input.add('events', { ...base(id(931)), ...fields, applicationId, evidenceId: input.evidence[0]!.id, supersedesEventId: null });
  const receipt = input.add('creation_requests', { id: id(932), createdAt: instant, clientId, entityType: 'event',
    payloadHash: transferHash({ operation: 'import_historical_event', applicationId, event: historicalEvent }),
    resultApplicationId: null, resultContactId: null, resultTaskId: null, resultEventId: event.id,
    resultResumeId: null, resultEvidenceId: null, resultCycleId: null });
  const applyRequest = id(950);
  for (const [row, auditId, requestId] of [[applied, 951, applyRequest], [selected, 952, id(953)]] as const) {
    importInsertAudit(input, requestId, auditId, 'import_rows', row.id, {
      source_file_id: row.sourceFileId, row_number: row.rowNumber, row_hash: row.rowHash, original_text: row.originalText,
      legacy_id: row.legacyId, target_application_id: row.targetApplicationId, result: row.result, pending_issues: row.pendingIssues,
      applied_target_version: row.appliedTargetVersion, resolution: row.resolution, unit_result: row.unitResult,
    });
  }
  const evidence = input.evidence[0]!;
  importInsertAudit(input, applyRequest, 954, 'evidence', evidence.id, {
    kind: evidence.kind, original_text: evidence.originalText, source: evidence.source, occurred_date: evidence.occurredDate,
    captured_at: evidence.capturedAt, private_ref: evidence.privateRef, local_ref: evidence.localRef,
  });
  for (const [entry, auditId] of [[input.events[0]!, 955], [event, 956]] as const) {
    importInsertAudit(input, applyRequest, auditId, 'events', entry.id, {
      application_id: entry.applicationId, kind: entry.kind, state: entry.state, evidence_id: entry.evidenceId,
      occurred_date: entry.occurredDate, source_text: entry.sourceText, result_text: entry.resultText, score_value: entry.scoreValue,
      score_unit: entry.scoreUnit, supersedes_event_id: entry.supersedesEventId,
    });
  }
  return { input, selected, applied, event, receipt };
}

it('aceita o replay auditado do evento já registrado com a evidência original do baseline', async () => {
  const { input } = await auditedHistoricalReplay();
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { eventos_historicos_verificados: 1 } });
});

it('retém o skip quando só a sua resolução perde o pedido de evento ainda auditado', async () => {
  const { input, selected } = await auditedHistoricalReplay();
  resolutionOf(selected).request.historicalEvents = [];
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { auditoria_da_unidade_divergente: 1 } });
});

it('retém a perda do pedido, evento e recibo quando as duas auditorias preservam as resoluções', async () => {
  const { input, selected, applied, event, receipt } = await auditedHistoricalReplay();
  resolutionOf(selected).request.historicalEvents = [];
  resolutionOf(applied).request.historicalEvents = [];
  for (const removed of [event, receipt]) {
    const index = input.entities.findIndex((entity) => entity.data === removed);
    input.entities.splice(index, 1);
  }
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { auditoria_da_unidade_divergente: 2 } });
});

async function laterImportWithPriorConfirmation(withLongPriorSource = false) {
  const input = await fixture();
  const earlierCsv = input.archived[0]!.originalText!.replace(' Observação fictícia ', ' Observação anterior fictícia ');
  const [prior] = priorImport(input, withLongPriorSource ? earlierCsv.replace('Fonte fictícia', longAttribution) : earlierCsv);
  const row = input.importRows[0]!;
  const app = input.applications[0]!;
  const priorEvidence = input.add('evidence', { ...input.evidence[0]!, id: id(933), originalText: prior!.originalText });
  if (withLongPriorSource) {
    priorEvidence.source = null;
    prior!.pendingIssues = [...prior!.pendingIssues, sourceProjectionWarning];
  }
  const priorEvent = input.add('events', { ...input.events[0]!, id: id(934), evidenceId: priorEvidence.id });
  app.version = 2;
  row.appliedTargetVersion = 2;
  row.unitResult = { applicationId: app.id, version: 2, result: 'imported' };
  resolutionOf(row).request.expectedVersion = 1;
  resolutionOf(row).request.expectedOpportunityVersion = 1;
  resolutionOf(row).request.decisions = Object.fromEntries(LEGACY_HEADER.map((column) => [column, column === 'status_envio' ? 'current' : 'source']));
  input.events[0]!.kind = 'nota';
  const unchanged = input.importRows[1]!;
  unchanged.result = 'skipped';
  unchanged.unitResult = { applicationId: unchanged.targetApplicationId, version: 1, result: 'skipped' };
  return { input, prior: prior!, priorEvidence, priorEvent };
}

it('aceita uma confirmação anterior comprovada e retém duas confirmações com a mesma prova', async () => {
  const { input, priorEvent } = await laterImportWithPriorConfirmation();
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { confirmacoes_retidas_de_versoes_anteriores: 1 } });
  input.add('events', { ...priorEvent, id: id(935) });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { confirmacao_com_prova_duplicada: 2 } });
});

it('exige o aviso da atribuição longa no registro de uma confirmação anterior', async () => {
  const { input, prior } = await laterImportWithPriorConfirmation(true);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { confirmacoes_retidas_de_versoes_anteriores: 1 } });
  prior.pendingIssues = prior.pendingIssues.filter((code) => code !== sourceProjectionWarning);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { confirmacao_sem_proveniencia: 1, confirmacao_anterior_ausente: 1 } });
});

it('verifica um evento histórico explicitamente pedido na versão anterior à nota atual', async () => {
  const { input, prior, priorEvidence } = await laterImportWithPriorConfirmation();
  resolutionOf(prior).request.historicalEvents = [historicalEvent];
  const { clientId, ...fields } = historicalEvent;
  const applicationId = input.applications[0]!.id;
  const event = input.add('events', { ...base(id(957)), ...fields, applicationId, evidenceId: priorEvidence.id, supersedesEventId: null });
  const receipt = input.add('creation_requests', { id: id(958), createdAt: instant, clientId, entityType: 'event',
    payloadHash: transferHash({ operation: 'import_historical_event', applicationId, event: historicalEvent }),
    resultApplicationId: null, resultContactId: null, resultTaskId: null, resultEventId: event.id,
    resultResumeId: null, resultEvidenceId: null, resultCycleId: null });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { confirmacoes_retidas_de_versoes_anteriores: 1, eventos_historicos_verificados: 1 } });
  for (const removed of [event, receipt]) input.entities.splice(input.entities.findIndex((entity) => entity.data === removed), 1);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { evento_historico_divergente: 1 } });
});

it('retém confirmação ordinária anterior com estado e pontuação de outro tipo de evento', async () => {
  const { input, priorEvent } = await laterImportWithPriorConfirmation();
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { confirmacoes_retidas_de_versoes_anteriores: 1 } });
  priorEvent.state = 'agendado';
  priorEvent.scoreValue = 12;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { confirmacao_sem_proveniencia: 1, confirmacao_anterior_ausente: 1 } });
});

function ownerAudit(input: Fixture, requestId: string, identifier: number, entityType: string, entityId: string,
  operation: 'update' | 'insert', beforeData: unknown, afterData: unknown) {
  return input.add('audit_log', { id: id(identifier), requestId, actor: { kind: 'owner', id: ownerId }, source: 'web',
    occurredAt: instant, entityType, entityId, operation, beforeData, afterData, diff: {}, createdAt: instant });
}

it('vincula a confirmação operacional ao insert exato e consome a transição de status uma vez', async () => {
  const input = await fixture();
  priorImport(input, input.archived[0]!.originalText!.replace(/ Observação fictícia (?=,2026-02-04\r\n$)/, ' Observação anterior fictícia '));
  const [unchanged, row] = input.importRows as [Data<'import_rows'>, Data<'import_rows'>];
  unchanged.result = 'skipped';
  unchanged.unitResult = { applicationId: unchanged.targetApplicationId, version: 1, result: 'skipped' };
  const app = input.applications[1]!;
  app.version = 3;
  row.appliedTargetVersion = 3;
  row.unitResult = { applicationId: app.id, version: 3, result: 'imported' };
  resolutionOf(row).request.expectedVersion = 2;
  resolutionOf(row).request.expectedOpportunityVersion = 1;
  resolutionOf(row).request.decisions = Object.fromEntries(LEGACY_HEADER.map((column) => [column, 'source']));
  const evidence = input.add('evidence', { ...input.evidence[1]!, id: id(942), kind: 'relato_usuario', originalText: 'Envio informado' });
  const event = input.add('events', { ...input.events[1]!, id: id(943), kind: 'envio_confirmado', evidenceId: evidence.id,
    resultText: null, sourceText: null });
  const requestId = id(944);
  const before = { id: app.id, version: 1, submission_status: 'nao_confirmado', submitted_date: unknown };
  ownerAudit(input, requestId, 945, 'applications', app.id, 'update', before, { ...before, version: 2, submission_status: 'confirmado' });
  const after = { id: event.id, application_id: app.id, kind: event.kind, state: event.state, evidence_id: evidence.id,
    occurred_date: unknown, result_text: null, source_text: null, score_value: null, score_unit: null, supersedes_event_id: null };
  ownerAudit(input, requestId, 946, 'events', event.id, 'insert', null, after);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { confirmacoes_operacionais_auditadas: 1 } });
  const duplicate = input.add('events', { ...event, id: id(947) });
  ownerAudit(input, requestId, 948, 'events', duplicate.id, 'insert', null, { ...after, id: duplicate.id });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { confirmacao_com_prova_duplicada: 2 } });
});

it('retém fusão sem autorização e aceita a correção com auditoria e evidência vinculadas', async () => {
  const input = await fixture();
  const [app, target] = input.applications as [Data<'applications'>, Data<'applications'>];
  app.canonicalApplicationId = target.id;
  app.countingEligible = false;
  app.version = 2;
  target.version = 2;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { supressao_de_contagem_sem_proveniencia: 1 } });
  const requestId = id(936);
  const before = { id: app.id, version: 1, canonical_application_id: null, counting_eligible: true, normalized_track: '', application_instance: app.applicationInstance };
  ownerAudit(input, requestId, 937, 'applications', app.id, 'update', before, { ...before, version: 2, canonical_application_id: target.id, counting_eligible: false });
  const targetBefore = { ...before, id: target.id };
  ownerAudit(input, requestId, 938, 'applications', target.id, 'update', targetBefore, { ...targetBefore, version: 2 });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { supressao_de_contagem_sem_proveniencia: 1 } });
  const correction = input.add('events', { ...input.events[0]!, id: id(939), kind: 'correcao', sourceText: null, resultText: 'Duplicata fictícia revisada' });
  ownerAudit(input, requestId, 940, 'events', correction.id, 'insert', null, { id: correction.id, application_id: app.id,
    kind: correction.kind, state: correction.state, evidence_id: correction.evidenceId, occurred_date: correction.occurredDate,
    result_text: correction.resultText, score_value: null, score_unit: null, source_text: null, supersedes_event_id: null });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { supressoes_de_contagem_auditadas: 1 } });
});

it('retém supressão de contagem sem correção mesmo sem alvo canônico', async () => {
  const input = await fixture();
  input.applications[0]!.countingEligible = false;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { supressao_de_contagem_sem_proveniencia: 1 } });
});

it('verifica alocação e elegibilidade dos membros originais de uma revisão fechada', async () => {
  const input = await fixture(true);
  const member = input.entities.find((entity) => entity.table === 'batch_members')!;
  if (member.table !== 'batch_members') throw new Error('Membro fictício ausente');
  member.data.allocation = 'excluded';
  member.data.eligible = false;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { revisao_historica_divergente: 1 } });
});

it('aceita o reaproveitamento de link nativo, mas detecta projeção legada contraditória da mesma URL', async () => {
  const input = await fixture();
  const link = input.links[0]![0]!;
  link.kind = 'original';
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, discrepancies: {} });
  input.add('links', { ...link, id: id(941), kind: 'legado', isPrivate: true });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { classificacao_de_referencia_legada_divergente: 1 } });
});

it('aceita o reaproveitamento da mesma URL por tipos nativos distintos', async () => {
  const input = await fixture();
  const link = input.links[0]![0]!;
  link.kind = 'original';
  input.add('links', { ...link, id: id(949), kind: 'outro' });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { referencias_reaproveitadas: 1 } });
});

it.each(['avisos_do_lote_divergentes', 'avisos_da_linha_divergentes'] as const)('mantém avisos esperados e detecta %s', async (category) => {
  const input = await fixture();
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { avisos_na_fonte: 4 } });
  if (category === 'avisos_do_lote_divergentes') input.run.pendingIssues = [];
  else input.importRows[0]!.pendingIssues = ['unresolved_tenant_channels_stage', 'unresolved_identity'];
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { [category]: 1 } });
});

it('preserva a revisão ligada ao arquivo e detecta alteração da projeção histórica', async () => {
  const input = await fixture(true);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { revisoes_verificadas: 1 } });
  input.review!.snapshot.asOf = '2026-02-06T12:00:00.000Z';
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { revisao_historica_divergente: 1 } });
});

function reviewSuccessor(input: Fixture, predecessor: Data<'review_versions'>, type: 'revision' | 'rectification', identifier: number) {
  const successor = input.add('review_versions', { ...structuredClone(predecessor), ...base(id(identifier)), type,
    predecessorId: predecessor.id, versionNumber: predecessor.versionNumber + 1, narrative: 'Análise posterior fictícia',
    decisions: ['Decisão posterior fictícia'], reason: 'Correção documentada', evidenceId: input.evidence[0]!.id,
  });
  if (type === 'rectification') {
    const rows = input.applications.map((app, i) => analyticsRowSchema.strip().parse({ ...app,
      company: input.manifest.parsed.rows[i]!.company, title: input.manifest.parsed.rows[i]!.title, seniority: null,
      modality: null, batchIds: [batchId], stack: [], resumeIds: [] })).sort((a, b) => a.id.localeCompare(b.id));
    const events = input.events.map((event) => analyticsEventSchema.strip().parse({ ...event, recordedAt: event.createdAt }));
    const snapshot = buildReviewSnapshot(rows, events, predecessor.populationIds, '2026-02-06T12:00:00.000Z');
    const eventEvidence = input.events.map((event, i) => {
      const { id, kind, originalText, source, occurredDate, privateRef, localRef } = input.evidence[i]!;
      return { eventId: event.id, evidence: { id, kind, originalText, source, occurredDate, privateRef, localRef } };
    });
    successor.snapshot = reviewSnapshotSchema.parse({ ...snapshot, eventEvidence, resumeRefs: [] });
    successor.eventIds = snapshot.eventIds;
    successor.calculationVersion = snapshot.calculationVersion;
  }
  return successor;
}

it('preserva a ordem capturada na retificação nativa e na revisão posterior', async () => {
  const input = await fixture(true);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { revisoes_verificadas: 1, registros_verificados: 30 } });
  const revision = reviewSuccessor(input, input.review!, 'revision', 5);
  const rectification = reviewSuccessor(input, revision, 'rectification', 4);
  expect(rectification.populationIds).toEqual(input.applications.map((app) => app.id));
  expect(rectification.snapshot.populationIds).toEqual([...rectification.populationIds].reverse());
  reviewSuccessor(input, rectification, 'revision', 3);
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { revisoes_verificadas: 1, versoes_posteriores_de_revisao: 3 } });
});

it.each(['ausente', 'duplicado', 'fora de ordem', 'ordem externa alterada'])('retém retificação com membro %s', async (defect) => {
  const input = await fixture(true);
  const rectification = reviewSuccessor(input, input.review!, 'rectification', 5);
  const inner = rectification.snapshot.populationIds;
  if (defect === 'ausente') inner.pop();
  if (defect === 'duplicado') inner[1] = inner[0]!;
  if (defect === 'fora de ordem') inner.reverse();
  if (defect === 'ordem externa alterada') rectification.populationIds.reverse();
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { cadeia_de_revisao_divergente: 1 } });
});

it('preserva os microssegundos do fechamento original e aceita a precisão herdada do PostgreSQL', async () => {
  const closedAt = '2026-02-05T12:00:00.123456Z';
  const input = await fixture(true, { closedAt });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { revisoes_verificadas: 1, registros_verificados: 30 } });
  const revision = reviewSuccessor(input, input.review!, 'revision', 5);
  const inherited: Date = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ)(closedAt.replace('T', ' ').replace('Z', '+00'));
  expect(inherited.toISOString()).toBe('2026-02-05T12:00:00.123Z');
  revision.closedAt = inherited.toISOString().replace('Z', '+00:00');
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { revisoes_verificadas: 1, versoes_posteriores_de_revisao: 1 } });

  input.review!.closedAt = revision.closedAt;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { revisao_historica_divergente: 1 } });
});

it.each([
  ['2026-02-05T12:00:00.123456Z', null],
  ['2026-02-05T12:00:00.123456Z', '2026-02-05T12:00:00.123001Z'],
  ['2026-02-05T12:00:00.123456Z', '2026-02-05T12:00:00.123456Z'],
  ['2026-02-05T12:00:00.123456Z', '2026-02-05T12:00:00.124Z'],
  ['2026-02-05T12:00:00.123456Z', '2026-02-06T12:00:00.123Z'],
  [null, '2026-02-05T12:00:00.123Z'],
] as const)('retém o fechamento divergente da revisão posterior (%s → %s)', async (closedAt, changed) => {
  const input = await fixture(true, { closedAt });
  const revision = reviewSuccessor(input, input.review!, 'revision', 5);
  revision.closedAt = changed;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { cadeia_de_revisao_divergente: 1 } });
});

it('retém a versão posterior que pula uma versão da cadeia', async () => {
  const input = await fixture(true);
  const revision = reviewSuccessor(input, input.review!, 'revision', 5);
  revision.versionNumber += 1;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { cadeia_de_revisao_divergente: 1 } });
});

it('retém originais concorrentes associados ao mesmo Markdown', async () => {
  const input = await fixture(true);
  input.add('review_versions', { ...structuredClone(input.review!), id: id(5) });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { revisao_com_mapeamento_duplicado: 1 } });
});

it('retém decisões estruturadas acrescentadas à revisão original importada', async () => {
  const input = await fixture(true);
  input.review!.decisions = ['Decisão estruturada fictícia criada fora da importação'];
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { revisao_historica_divergente: 1 } });
});

it('retém a revisão quando o arquivo está arquivado sem vínculo verificável', async () => {
  const input = await fixture(true);
  input.run.unitState = { cycleId, completed: { reviewRequired: false, runId, rowCount: 30 } };
  input.review!.importProvenance = null;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { revisao_sem_vinculo_verificavel: 1 } });
});

it('rejeita o manifesto ou o export com hashes alterados', async () => {
  const input = await fixture();
  await input.save();
  const manifest = JSON.parse(await readFile(input.manifestFile, 'utf8')) as PreviewManifest;
  await writeFile(input.manifestFile, JSON.stringify({ ...manifest, sourceSetHash: '0'.repeat(64) }));
  expect(await check(input)).toMatchObject({ exitCode: 1, discrepancies: { manifesto_invalido: 1 } });
  await writeFile(input.manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(input.exportFile, (await readFile(input.exportFile, 'utf8')).replace('Empresa fictícia', 'Empresa modificada'));
  expect(await check(input)).toMatchObject({ exitCode: 1, discrepancies: { exportacao_invalida: 1 } });
});

it('rejeita manifesto que referencia outro diretório de cópia', async () => {
  const first = await fixture();
  const other = await fixture();
  await first.save();
  await writeFile(first.manifestFile, JSON.stringify({ ...first.manifest, snapshotDirectory: other.manifest.snapshotDirectory }, null, 2) + '\n');
  expect(await check(first)).toMatchObject({ exitCode: 1, discrepancies: { manifesto_invalido: 1 } });
});

it('rejeita adulteração dos bytes arquivados ao lado do manifesto', async () => {
  const input = await fixture();
  await input.save();
  await writeFile(path.join(path.dirname(input.manifestFile), 'sources', 'ficticio.csv'), 'CSV fictício adulterado');
  expect(await check(input)).toMatchObject({ exitCode: 1, discrepancies: { manifesto_invalido: 1 } });
});

it('classifica perda de texto de arquivo-fonte no export com bytes preservados', async () => {
  const input = await fixture();
  input.archived[0]!.originalText = null;
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { arquivo_arquivado_divergente: 1 } });
});

it('classifica a falta de proveniência de alterações na etapa estruturada', async () => {
  const input = await fixture();
  input.applications[0]!.stage = 'contratacao';
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { etapa_atual_sem_proveniencia: 1 } });
});

it('retém uma confirmação extra sem vínculo com linha ou alteração auditada de status', async () => {
  const input = await fixture();
  input.add('events', { ...input.events[0]!, id: id(920), evidenceId: null });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { confirmacao_sem_proveniencia: 1 } });
});

it('retém referências extras que se dizem legadas sem correspondente arquivado', async () => {
  const input = await fixture();
  input.add('links', { ...input.links[0]![0]!, id: id(921), originalUrl: 'https://example.test/unmapped' });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { referencia_legada_sem_historico: 1 } });
});

it('preserva a referência apenas no arquivo e aceita link nativo independente com o mesmo texto', async () => {
  const input = await fixture(false, { withArchiveReference: true });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { referencias_somente_no_original: 1 } });
  input.add('links', { ...input.links[0]![0]!, id: id(959), originalUrl: archiveReference, kind: 'arquivo', isLocal: true, isPrivate: false });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 0, counts: { referencias_somente_no_original: 1 } });
  input.add('links', { ...input.links[0]![0]!, id: id(960), originalUrl: archiveReference, kind: 'legado', isLocal: true, isPrivate: false });
  await input.save();
  expect(await check(input)).toMatchObject({ exitCode: 2, discrepancies: { referencia_somente_no_original_projetada: 1 } });
});
