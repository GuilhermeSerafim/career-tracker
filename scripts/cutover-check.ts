import { execFileSync } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { MAX_SNAPSHOT_BYTES, transferHash, type Snapshot, type TransferTable } from '../domain/export.js';
import { LEGACY_HEADER, parseLegacyCsv, projectLegacySourceAttribution, UNPROJECTED_SOURCE_ATTRIBUTION, type LegacyColumn, type LegacyRow } from '../domain/import.js';
import { cycleRelationSchema, dateValueSchema, eventFields, instantSchema, linkDataSchema, opportunityKindSchema, positiveVersionSchema, sha256Schema, stageSchema, uuidSchema } from '../shared/model.js';
import type { TransferEntity } from '../shared/transfer.js';
import { manifestSchema, verifyPreviewArtifact, type PreviewManifest } from './import-legacy.js';
import { readPrivateSnapshot } from './private-transfer-io.js';

type Data<T extends TransferTable> = Extract<TransferEntity, { table: T }>['data'];
type ImportRow = Data<'import_rows'>;
type App = Data<'applications'>;
type Audit = Data<'audit_log'>;
type Event = Data<'events'>;
type Review = Data<'review_versions'>;
type Count = (category: string, size?: number) => void;
interface Result {
  exitCode: 0 | 1 | 2;
  counts: Record<string, number>;
  discrepancies: Record<string, number>;
}

const unitResultSchema = z.object({ applicationId: uuidSchema, version: positiveVersionSchema, result: z.enum(['imported', 'skipped']) });
const interpretationSchema = z.object({
  track: z.string().nullable(), applicationInstance: z.string(), cycleRelation: cycleRelationSchema,
  kind: opportunityKindSchema, provider: z.string().nullable(), tenant: z.string().nullable(),
});
const resolutionSchema = z.object({
  request: z.object({
    runId: uuidSchema, legacyId: z.string(), expectedVersion: positiveVersionSchema.nullable(),
    interpretation: interpretationSchema, decisions: z.record(z.enum(LEGACY_HEADER), z.enum(['source', 'current'])).nullable(),
    historicalEvents: z.array(z.strictObject({ clientId: uuidSchema, ...eventFields })).max(100),
  }),
  appliedInterpretation: interpretationSchema,
});
type Resolution = z.infer<typeof resolutionSchema>;
const completedSchema = z.object({ runId: uuidSchema, rowCount: z.number().int().nonnegative(), reviewRequired: z.boolean() });
const reviewUnitSchema = z.object({ requestHash: sha256Schema, result: z.object({ batchId: uuidSchema, reviewId: uuidSchema }) });
const reviewProvenanceSchema = z.strictObject({
  runId: uuidSchema, sourceFileId: uuidSchema, sourceHash: sha256Schema, importerVersion: z.string(),
  historicalClosedDate: dateValueSchema, documentedUpdatedDate: dateValueSchema,
  snapshotTimeMeaning: z.enum(['import_capture', 'historical_instant']), importedAt: instantSchema,
  pendingIssues: z.array(z.string()),
});
const unknownDate = { precision: 'unknown', value: null };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function select<T extends TransferTable>(snapshot: Snapshot, table: T): Data<T>[] {
  return snapshot.entities.flatMap((item) => item.table === table ? [item.data as Data<T>] : []);
}
function index<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}
function group<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = result.get(key);
    if (existing) existing.push(item);
    else result.set(key, [item]);
  }
  return result;
}

function privateExportIndex(snapshot: Snapshot) {
  const runs = select(snapshot, 'import_runs');
  const files = select(snapshot, 'source_files');
  const rows = select(snapshot, 'import_rows');
  const apps = select(snapshot, 'applications');
  const audit = select(snapshot, 'audit_log');
  const reviews = select(snapshot, 'review_versions');
  const events = select(snapshot, 'events');
  return {
    runs, allRuns: index(runs), allFiles: index(files), filesByRun: group(files, (file) => file.importRunId),
    rowsByFile: group(rows, (row) => row.sourceFileId), rowsByLegacy: group(rows, (row) => row.legacyId),
    apps, appsById: index(apps), appsByLegacy: group(apps, (app) => app.legacyId),
    opportunities: index(select(snapshot, 'opportunities')), evidence: index(select(snapshot, 'evidence')),
    eventsByApp: group(events, (event) => event.applicationId), eventsById: index(events),
    linksByApp: group(select(snapshot, 'links'), (link) => link.applicationId),
    auditByEntity: group(audit, (entry) => entry.entityType + '/' + entry.entityId),
    auditByRequest: group(audit, (entry) => entry.requestId),
    eventRequests: group(select(snapshot, 'creation_requests').filter((request) => request.entityType === 'event'), (request) => request.clientId),
    reviews, reviewsById: index(reviews), batches: index(select(snapshot, 'batches')),
    membersByBatch: group(select(snapshot, 'batch_members'), (member) => member.batchId),
  };
}
type ExportIndex = ReturnType<typeof privateExportIndex>;

function readArchivedRow(imported: ImportRow) {
  return parseLegacyCsv(LEGACY_HEADER.join(',') + '\n' + imported.originalText).rows[0];
}

function legacyLinkProjection(reference: LegacyRow['links'][number]) {
  const { originalText, classification } = reference;
  const link = { originalUrl: originalText, comparisonUrl: null, kind: 'legado', isLocal: classification === 'local', isPrivate: classification !== 'web' };
  if (['web', 'private', 'local'].includes(classification) && originalText.trim() && linkDataSchema.safeParse(link).success) return link;
}

function sameRequest(a: Audit, b: Audit) {
  return a.requestId === b.requestId && a.actor.kind === b.actor.kind && a.actor.id === b.actor.id && a.source === b.source;
}
function operationalAudit(entry: Audit) {
  return entry.actor.kind === 'owner' && entry.source === 'web' || entry.actor.kind === 'agent' && entry.source === 'agent';
}
function matchesEventInsert(entry: Audit, event: Event) {
  const state = record(entry.afterData);
  return entry.entityType === 'events' && entry.entityId === event.id && entry.operation === 'insert' && entry.beforeData === null &&
    state?.id === event.id && state.application_id === event.applicationId && state.kind === event.kind && state.state === event.state &&
    state.evidence_id === event.evidenceId && equal(state.occurred_date, event.occurredDate) && state.result_text === event.resultText &&
    state.source_text === event.sourceText && state.score_value === event.scoreValue && state.score_unit === event.scoreUnit &&
    state.supersedes_event_id === event.supersedesEventId;
}
function appVersionTransition(entry: Audit, app: App) {
  const before = record(entry.beforeData);
  const after = record(entry.afterData);
  return entry.entityType === 'applications' && entry.entityId === app.id && entry.operation === 'update' &&
    before?.id === app.id && after?.id === app.id && typeof before.version === 'number' && before.version >= 1 &&
    after.version === before.version + 1 && after.version <= app.version ? { before, after } : undefined;
}

function isUnscoredInformationalEvent(event: Event) {
  return event.state === 'informado' && event.scoreValue === null && event.scoreUnit === null && event.supersedesEventId === null;
}

const nativeStageKinds: Partial<Record<App['stage'], Event['kind']>> = {
  avaliacao: 'avaliacao', entrevista: 'entrevista', proposta: 'proposta', contratacao: 'contratacao',
  rejeicao: 'rejeicao', desistencia: 'desistencia', processo_encerrado: 'encerramento',
};

function hasNativeStageProof(app: App, appAudit: Audit[], data: ExportIndex) {
  const changes = appAudit.flatMap((entry) => {
    const transition = operationalAudit(entry) && appVersionTransition(entry, app);
    if (!transition || transition.before.stage === transition.after.stage || !stageSchema.safeParse(transition.before.stage).success ||
      !stageSchema.safeParse(transition.after.stage).success) return [];
    return [{ entry, version: Number(transition.after.version), stage: transition.after.stage }];
  }).sort((a, b) => b.version - a.version);
  const change = changes[0];
  if (!change || change.stage !== app.stage || change.version === changes[1]?.version) return false;
  const kind = nativeStageKinds[app.stage] ?? 'etapa_alterada';
  return (data.eventsByApp.get(app.id) ?? []).some((event) => event.kind === kind && event.sourceText === app.stage &&
    event.resultText === null && isUnscoredInformationalEvent(event) && equal(event.occurredDate, unknownDate) &&
    (data.auditByEntity.get('events/' + event.id) ?? []).some((insert) => sameRequest(change.entry, insert) && matchesEventInsert(insert, event)));
}

function checkCountingCorrection(app: App, appAudit: Audit[], data: ExportIndex, count: Count, discrepancy: Count) {
  if (app.canonicalApplicationId === null && app.countingEligible) return;
  const target = app.canonicalApplicationId ? data.appsById.get(app.canonicalApplicationId) : undefined;
  const corrections = (data.eventsByApp.get(app.id) ?? []).filter((event) => event.kind === 'correcao' && event.state === 'informado' &&
    equal(event.occurredDate, unknownDate) && event.evidenceId && data.evidence.has(event.evidenceId) &&
    event.resultText?.trim() && event.sourceText === null && event.scoreValue === null && event.scoreUnit === null && event.supersedesEventId === null);
  const proved = !app.countingEligible && appAudit.some((entry) => {
    if (!operationalAudit(entry)) return false;
    const transition = appVersionTransition(entry, app);
    if (!transition) return false;
    const { before, after } = transition;
    if (before.canonical_application_id !== null || typeof before.counting_eligible !== 'boolean' ||
      after.canonical_application_id !== app.canonicalApplicationId || after.counting_eligible !== false ||
      !target && !before.counting_eligible) return false;
    const request = (data.auditByRequest.get(entry.requestId) ?? []).filter((audit) => sameRequest(entry, audit));
    const correctionIds = new Set(request.flatMap((audit) => corrections.filter((event) => matchesEventInsert(audit, event)).map((event) => event.id)));
    if (correctionIds.size !== 1) return false;
    if (!target) return app.canonicalApplicationId === null;
    return request.some((audit) => {
      const targetChange = appVersionTransition(audit, target);
      return target.id !== app.id && targetChange?.before.canonical_application_id === null && targetChange.after.canonical_application_id === null &&
        typeof targetChange.before.counting_eligible === 'boolean' && targetChange.after.counting_eligible === targetChange.before.counting_eligible &&
        typeof before.normalized_track === 'string' && before.normalized_track === targetChange.before.normalized_track &&
        typeof before.application_instance === 'string' && before.application_instance === targetChange.before.application_instance;
    });
  });
  if (proved) count('supressoes_de_contagem_auditadas');
  else discrepancy('supressao_de_contagem_sem_proveniencia');
}

function checkLiveProjection(row: LegacyRow, app: App, resolution: Resolution, applied: ImportRow, history: ImportRow[],
  data: ExportIndex, count: Count, discrepancy: Count) {
  const { appliedInterpretation: interpretation, request: { decisions } } = resolution;
  const opportunity = data.opportunities.get(app.opportunityId)!;
  const appAudit = data.auditByEntity.get('applications/' + app.id) ?? [];
  const opportunityAudit = data.auditByEntity.get('opportunities/' + opportunity.id) ?? [];
  function compare(column: LegacyColumn, expected: unknown, actual: unknown, category: string, field: string, opportunityField = false) {
    if (equal(expected, actual)) return;
    if (column && decisions?.[column] === 'current') discrepancy('decisao_preserva_valor_atual');
    else if ((opportunityField ? opportunityAudit : appAudit).some((entry) => entry.operation === 'update' && entry.actor.kind !== 'import' &&
      equal(record(entry.afterData)?.[field], actual) && !equal(record(entry.beforeData)?.[field], actual) &&
      Number(record(entry.afterData)?.version) === (opportunityField ? opportunity.version : app.version))) discrepancy('edicao_posterior_auditada');
    else discrepancy(category);
  }
  compare('ordem_ciclo', row.cycleOrder, app.cycleOrder, 'ordem_projetada_divergente', 'cycle_order');
  compare('status_envio', row.submissionStatus, app.submissionStatus, 'status_envio_divergente', 'submission_status');
  compare('data_envio', row.submittedDate, app.submittedDate, row.submittedDate.precision === 'unknown' ? 'data_desconhecida_divergente' : 'data_envio_divergente', 'submitted_date');
  compare('registrado_em', row.legacyRegisteredDate, app.legacyRegisteredDate, 'data_registro_divergente', 'legacy_registered_date');
  compare('cv_enviado', row.legacyResumeText || null, app.legacyResumeText, 'cv_original_divergente', 'legacy_resume_text');
  compare('observacoes', row.fields.observacoes || null, app.notes, 'texto_original_divergente', 'notes');
  compare('empresa', row.company || null, opportunity.company, 'oportunidade_divergente', 'company', true);
  compare('cargo', row.title || null, opportunity.title, 'oportunidade_divergente', 'title', true);
  compare('plataforma', (interpretation.provider ?? row.legacyPlatform) || null, opportunity.platform, 'oportunidade_divergente', 'platform', true);
  compare('codigo_vaga', row.jobCode || null, opportunity.jobCode, 'oportunidade_divergente', 'job_code', true);
  compare('chave_vaga', row.jobKey || null, opportunity.jobKey, 'oportunidade_divergente', 'job_key', true);
  if (!equal([app.track, app.applicationInstance, app.cycleRelation, opportunity.kind, opportunity.tenant],
    [interpretation.track, interpretation.applicationInstance, interpretation.cycleRelation, interpretation.kind, interpretation.tenant])) {
    discrepancy('interpretacao_atual_divergente');
  }
  if (app.stage !== 'desconhecida') {
    if (hasNativeStageProof(app, appAudit, data)) count('alteracoes_de_etapa_auditadas');
    else discrepancy('etapa_atual_sem_proveniencia');
  }
  if (app.version > applied.appliedTargetVersion!) count('registros_com_versao_posterior');
  if (app.discoveryChannel !== null || app.submissionPlatform !== null || app.archivedAt !== null) count('registros_com_estado_operacional_adicional');
  checkCountingCorrection(app, appAudit, data, count, discrepancy);

  const links = group(data.linksByApp.get(app.id) ?? [], (link) => link.originalUrl);
  const expectedLinks = group(row.links, (link) => link.originalText);
  for (const [originalUrl, references] of expectedLinks) {
    const attributes = legacyLinkProjection(references[0]!);
    const occurrences = links.get(originalUrl) ?? [];
    if (!attributes) {
      count('referencias_somente_no_original');
      discrepancy('referencia_somente_no_original_projetada', occurrences.filter((link) => link.kind === 'legado').length);
      continue;
    }
    const matches = occurrences.filter((link) => link.isLocal === attributes.isLocal && link.isPrivate === attributes.isPrivate);
    const conflicts = occurrences.filter((link) => link.kind === 'legado' && !matches.includes(link));
    if (conflicts.length) discrepancy('classificacao_de_referencia_legada_divergente', conflicts.length);
    const matchingLegacy = matches.filter((link) => link.kind === 'legado').length;
    if (matchingLegacy > 1) discrepancy('referencia_projetada_duplicada');
    if (matches.length) {
      if (!matchingLegacy && !conflicts.length) count('referencias_reaproveitadas');
      continue;
    }
    const column = originalUrl === row.fields.url_original ? 'url_original' : 'links_alternativos';
    discrepancy(decisions?.[column] === 'current' ? 'decisao_preserva_valor_atual' : 'referencia_original_divergente');
  }
  const additional = [...links].filter(([url]) => !expectedLinks.has(url)).flatMap(([, items]) => items);
  count('referencias_operacionais_adicionais', additional.filter((link) => link.kind !== 'legado').length);
  const legacy = additional.filter((link) => link.kind === 'legado');
  if (legacy.length) {
    const archived = history.filter((previous) => previous.id !== applied.id).flatMap((previous) => readArchivedRow(previous)?.links ?? []);
    const byOriginal = group(archived, (reference) => reference.originalText);
    for (const link of legacy) {
      const references = byOriginal.get(link.originalUrl) ?? [];
      const projected = references.flatMap((reference) => legacyLinkProjection(reference) ?? []);
      if (projected.some((reference) => link.isLocal === reference.isLocal && link.isPrivate === reference.isPrivate)) {
        count('referencias_retidas_de_versoes_anteriores');
      } else discrepancy(references.length && !projected.length ? 'referencia_somente_no_original_projetada' : 'referencia_legada_sem_historico');
    }
  }
}

function importUnitAudit(imported: ImportRow, data: ExportIndex) {
  const run = data.allRuns.get(data.allFiles.get(imported.sourceFileId)?.importRunId ?? '');
  const inserts = (data.auditByEntity.get('import_rows/' + imported.id) ?? []).filter((entry) => entry.operation === 'insert');
  if (!inserts.length) return { valid: true, request: [] as Audit[] };
  const first = inserts[0]!;
  const after = record(first.afterData);
  if (inserts.length !== 1 || first.actor.kind !== 'import' || first.source !== run?.importerVersion || first.beforeData !== null ||
    after?.id !== imported.id || after.source_file_id !== imported.sourceFileId || after.row_hash !== imported.rowHash ||
    after.target_application_id !== imported.targetApplicationId || after.applied_target_version !== imported.appliedTargetVersion ||
    after.result !== imported.result || !equal(after.resolution, imported.resolution) ||
    !equal(after.unit_result, imported.unitResult)) return { valid: false, request: [] as Audit[] };
  return { valid: true, request: (data.auditByRequest.get(first.requestId) ?? []).filter((entry) => sameRequest(first, entry)) };
}

function checkHistoricalEvents(app: App, applied: ImportRow, resolution: Resolution, captured: Resolution, history: ImportRow[],
  appliedRequest: Audit[], data: ExportIndex, count: Count, discrepancy: Count) {
  const origins = history.flatMap((origin) => {
    if (origin.id === applied.id) return [{ origin, events: resolution.request.historicalEvents, audit: appliedRequest }];
    const previous = resolutionSchema.safeParse(origin.resolution);
    if (!previous.success || previous.data.request.legacyId !== app.legacyId ||
      previous.data.request.runId !== data.allFiles.get(origin.sourceFileId)?.importRunId) {
      discrepancy('estado_da_importacao_historica_divergente');
      return [];
    }
    const audit = importUnitAudit(origin, data);
    if (!audit.valid) discrepancy('auditoria_da_unidade_divergente');
    return [{ origin, events: previous.data.request.historicalEvents, audit: audit.valid ? audit.request : null }];
  });
  const evidenceOrigins = group(origins, ({ origin }) => origin.originalText);
  const verified = new Map<string, string>();
  const payloads = [...origins.flatMap(({ events }) => events), ...captured.request.historicalEvents];
  for (const eventFields of new Map(payloads.map((fields) => [transferHash(fields), fields])).values()) {
    const { clientId, ...fields } = eventFields;
    const requests = data.eventRequests.get(clientId) ?? [];
    const event = data.eventsById.get(requests[0]?.resultEventId ?? '');
    if (requests.length !== 1 || !event || event.applicationId !== app.id || fields.kind === 'envio_confirmado' ||
      requests[0]!.payloadHash !== transferHash({ operation: 'import_historical_event', applicationId: app.id, event: eventFields }) ||
      Object.entries(fields).some(([key, value]) => !equal(value, record(event)?.[key])) ||
      verified.has(event.id) && verified.get(event.id) !== clientId) {
      discrepancy('evento_historico_divergente');
      continue;
    }
    const evidence = data.evidence.get(event.evidenceId ?? '');
    const originatesFromImport = evidence?.kind === 'texto_legado' && evidence.originalText !== null &&
      equal(evidence.occurredDate, unknownDate) && (evidenceOrigins.get(evidence.originalText) ?? []).some(({ events, audit }) =>
        audit !== null && events.some((request) => equal(request, eventFields)) &&
        (!audit.length || audit.some((entry) => matchesEventInsert(entry, event)) && audit.some((entry) => matchesEvidenceInsert(entry, evidence))));
    if (originatesFromImport) verified.set(event.id, clientId);
    else discrepancy('evento_historico_sem_proveniencia');
  }
  count('eventos_historicos_verificados', verified.size);
  return new Set(verified.keys());
}

function matchesEvidenceInsert(entry: Audit, evidence: Data<'evidence'>) {
  const state = record(entry.afterData);
  return entry.entityType === 'evidence' && entry.entityId === evidence.id && entry.operation === 'insert' && entry.beforeData === null &&
    state?.id === evidence.id && state.kind === evidence.kind && state.original_text === evidence.originalText &&
    state.source === evidence.source && equal(state.occurred_date, evidence.occurredDate);
}

function hasImportEventProof(event: Event, raw: string, request: Audit[], data: ExportIndex) {
  const evidence = data.evidence.get(event.evidenceId ?? '');
  return evidence?.originalText === raw && (!request.length ||
    request.some((entry) => matchesEvidenceInsert(entry, evidence)) && request.some((entry) => matchesEventInsert(entry, event)));
}

function sourceAttributionWarningMatches(row: ImportRow, warning: string | null) {
  return row.pendingIssues.filter((code) => code === UNPROJECTED_SOURCE_ATTRIBUTION).length === (warning ? 1 : 0);
}

function checkOtherConfirmations(app: App, event: Event, history: ImportRow[], data: ExportIndex, count: Count, discrepancy: Count) {
  const retained = history.flatMap((previous) => {
    const row = readArchivedRow(previous);
    const prior = resolutionSchema.safeParse(previous.resolution).data?.request;
    if (row?.submissionStatus !== 'confirmado' || !prior || prior.expectedVersion !== null && prior.decisions?.status_envio !== 'source') return [];
    const unit = importUnitAudit(previous, data);
    const edit = unit.request.find((entry) => entry.entityType === 'applications' && entry.entityId === app.id);
    const state = record(edit?.beforeData)?.submission_status;
    if (prior.expectedVersion !== null && state === 'confirmado') return [];
    if (!unit.valid || prior.expectedVersion !== null && state !== 'nao_confirmado' && state !== 'nao_enviado' ||
      prior.runId !== data.allFiles.get(previous.sourceFileId)?.importRunId || prior.legacyId !== app.legacyId) {
      discrepancy('confirmacao_anterior_sem_prova');
      return [];
    }
    const date = prior.decisions?.data_envio === 'current' ? record(edit?.afterData)?.submitted_date : row.submittedDate;
    return [{ previous, row, decisions: prior.decisions, request: unit.request, date }];
  });
  const confirmations = (data.eventsByApp.get(app.id) ?? []).filter((item) => item.id !== event.id && item.kind === 'envio_confirmado');
  const candidates = confirmations.map((confirmation) => {
    const evidence = data.evidence.get(confirmation.evidenceId ?? '');
    const proofs: { key: string; category: string; legacyEvidence?: string }[] = [];
    if (evidence?.kind === 'texto_legado' && evidence.id !== event.evidenceId && equal(evidence.occurredDate, unknownDate) &&
      isUnscoredInformationalEvent(confirmation)) {
      for (const { previous, row, decisions, request, date } of retained) {
        const attribution = projectLegacySourceAttribution(row.source, decisions?.fonte);
        if (hasImportEventProof(confirmation, row.raw, request, data) &&
          evidence.source === attribution.source && sourceAttributionWarningMatches(previous, attribution.warning) &&
          confirmation.sourceText === (decisions?.evidencia_envio === 'current' ? null : row.evidence || null) &&
          confirmation.resultText === (decisions?.etapa === 'current' ? null : row.stageNarrative || null) &&
          equal(confirmation.occurredDate, date)) {
          proofs.push({ key: 'import/' + previous.id, category: 'confirmacoes_retidas_de_versoes_anteriores', legacyEvidence: evidence.id });
        }
      }
    }
    if (evidence && isUnscoredInformationalEvent(confirmation) && confirmation.resultText === null && confirmation.sourceText === null) {
      for (const insert of data.auditByEntity.get('events/' + confirmation.id) ?? []) {
        if (!operationalAudit(insert) || !matchesEventInsert(insert, confirmation)) continue;
        for (const update of data.auditByRequest.get(insert.requestId) ?? []) {
          if (!sameRequest(insert, update)) continue;
          const change = appVersionTransition(update, app);
          if ((change?.before.submission_status === 'nao_confirmado' || change?.before.submission_status === 'nao_enviado') &&
            change.after.submission_status === 'confirmado' && equal(change.after.submitted_date, confirmation.occurredDate)) {
            proofs.push({ key: 'operational/' + change.after.version, category: 'confirmacoes_operacionais_auditadas' });
          }
        }
      }
    }
    return proofs;
  });
  const proofUses = group(candidates.flat(), (proof) => proof.key);
  const evidenceUses = group(candidates.flat().filter((proof) => proof.legacyEvidence), (proof) => proof.legacyEvidence);
  for (const proofs of candidates) {
    const only = proofs[0];
    if (!only) discrepancy('confirmacao_sem_proveniencia');
    else if (proofs.length !== 1 || proofUses.get(only.key)!.length !== 1 ||
      only.legacyEvidence && evidenceUses.get(only.legacyEvidence)!.length !== 1) discrepancy('confirmacao_com_prova_duplicada');
    else count(only.category);
  }
  for (const { previous } of retained) {
    if (!proofUses.has('import/' + previous.id)) discrepancy('confirmacao_anterior_ausente');
  }
}

function checkEvidence(row: LegacyRow, app: App, imported: ImportRow, resolution: Resolution, captured: Resolution, history: ImportRow[], request: Audit[],
  data: ExportIndex, count: Count, discrepancy: Count) {
  const { decisions, expectedVersion } = resolution.request;
  const historicalIds = checkHistoricalEvents(app, imported, resolution, captured, history, request, data, count, discrepancy);
  const events = (data.eventsByApp.get(app.id) ?? []).filter((event) => !historicalIds.has(event.id) &&
    (event.kind === 'nota' || event.kind === 'envio_confirmado') && hasImportEventProof(event, row.raw, request, data));
  if (events.length !== 1) {
    discrepancy(events.length > 1 ? 'evidencia_com_mapeamento_duplicado' : 'evidencia_original_divergente');
    return;
  }
  const event = events[0]!;
  const evidence = data.evidence.get(event.evidenceId!)!;
  const attribution = projectLegacySourceAttribution(row.source, decisions?.fonte);
  const expectedStage = decisions?.etapa === 'current' ? null : row.stageNarrative || null;
  const expectedProof = decisions?.evidencia_envio === 'current' ? null : row.evidence || null;
  if (evidence.kind !== 'texto_legado' || evidence.source !== attribution.source || !equal(evidence.occurredDate, unknownDate) ||
    event.resultText !== expectedStage || event.sourceText !== expectedProof || !isUnscoredInformationalEvent(event)) discrepancy('evidencia_original_divergente');
  else if (attribution.warning && sourceAttributionWarningMatches(imported, attribution.warning)) count('atribuicoes_de_fonte_preservadas_no_original');
  if ((decisions?.fonte === 'current' && row.source) || (decisions?.etapa === 'current' && row.stageNarrative) ||
    (decisions?.evidencia_envio === 'current' && row.evidence)) count('textos_por_decisao_somente_no_original');

  const appEdit = request.find((entry) => entry.entityType === 'applications' && entry.entityId === app.id);
  const priorStatus = record(appEdit?.beforeData)?.submission_status;
  const canConfirm = row.submissionStatus === 'confirmado' && (expectedVersion === null || decisions?.status_envio === 'source');
  const mustConfirm = canConfirm && (expectedVersion === null || priorStatus !== undefined && priorStatus !== 'confirmado');
  const confirmed = event.kind === 'envio_confirmado';
  if (confirmed && (!canConfirm || priorStatus === 'confirmado') || !confirmed && (mustConfirm || event.kind !== 'nota')) {
    discrepancy('confirmacao_divergente');
  } else if (canConfirm && expectedVersion !== null && priorStatus === undefined) {
    discrepancy('confirmacao_sem_proveniencia');
  }
  const expectedDate = confirmed ? decisions?.data_envio === 'current' ? record(appEdit?.afterData)?.submitted_date : row.submittedDate : unknownDate;
  if (expectedDate === undefined) discrepancy('confirmacao_sem_proveniencia');
  else if (!equal(event.occurredDate, expectedDate)) {
    discrepancy(record(expectedDate)?.precision === 'unknown' ? 'data_desconhecida_divergente' : 'data_da_evidencia_divergente');
  }
  checkOtherConfirmations(app, event, history.filter((item) => item.id !== imported.id), data, count, discrepancy);
}

function checkRowWarnings(row: LegacyRow, imported: ImportRow, resolution: Resolution, sourceWarnings: string[], discrepancy: Count) {
  const expected = [...sourceWarnings];
  // Os avisos de mapeamento usam a interpretação pedida nesta unidade, inclusive em skips.
  if (!resolution.request.interpretation.provider || !row.jobCode.trim()) expected.push('unresolved_identity');
  if (row.links.some((link) => !legacyLinkProjection(link))) expected.push('unprojected_reference');
  if (imported.result === 'imported') {
    const { warning } = projectLegacySourceAttribution(row.source, resolution.request.decisions?.fonte);
    if (warning) expected.push(warning);
  }
  if (!equal(expected.sort(), [...imported.pendingIssues].sort())) discrepancy('avisos_da_linha_divergentes');
}

function reconcileRow(row: LegacyRow, imported: ImportRow, runId: string, sourceWarnings: string[], data: ExportIndex, count: Count, discrepancy: Count) {
  const byLegacy = data.appsByLegacy.get(row.legacyId) ?? [];
  const app = byLegacy[0];
  if (byLegacy.length > 1) { discrepancy('mapeamento_duplicado'); return; }
  if (!app || imported.targetApplicationId !== app.id || app.displayId !== row.legacyId) {
    discrepancy('identidade_original_divergente');
    return;
  }
  const history = data.rowsByLegacy.get(row.legacyId) ?? [];
  if (history.some((candidate) => candidate.targetApplicationId !== null && candidate.targetApplicationId !== app.id)) {
    discrepancy('mapeamento_duplicado');
    return;
  }
  const unit = unitResultSchema.safeParse(imported.unitResult);
  const captured = resolutionSchema.safeParse(imported.resolution);
  if (!unit.success || !captured.success || !imported.appliedTargetVersion || unit.data.applicationId !== app.id ||
    unit.data.result !== imported.result || captured.data.request.runId !== runId || captured.data.request.legacyId !== row.legacyId) {
    discrepancy('estado_da_importacao_divergente');
    return;
  }
  checkRowWarnings(row, imported, captured.data, sourceWarnings, discrepancy);
  const latest = history.filter((candidate) => candidate.result === 'imported' && candidate.appliedTargetVersion !== null && candidate.appliedTargetVersion !== undefined)
    .sort((a, b) => b.appliedTargetVersion! - a.appliedTargetVersion!);
  const applied = latest[0];
  if (applied && latest[1]?.appliedTargetVersion === applied.appliedTargetVersion) { discrepancy('mapeamento_duplicado'); return; }
  if (!applied || applied.rowHash !== row.rawRowHash || applied.originalText !== row.raw ||
    imported.appliedTargetVersion !== applied.appliedTargetVersion || (imported.result === 'imported' && (applied.id !== imported.id || unit.data.version !== imported.appliedTargetVersion))) {
    discrepancy('baseline_da_importacao_divergente');
    return;
  }
  if (imported.result === 'skipped') count('reaplicacoes_com_baseline');
  const resolution = resolutionSchema.safeParse(applied.resolution);
  if (!resolution.success || !equal(captured.data.appliedInterpretation, resolution.data.appliedInterpretation) ||
    !equal(resolution.data.request.interpretation, resolution.data.appliedInterpretation) ||
    resolution.data.request.legacyId !== row.legacyId || resolution.data.request.runId !== data.allFiles.get(applied.sourceFileId)?.importRunId) {
    discrepancy('estado_da_importacao_divergente');
    return;
  }
  if (imported.result === 'skipped' &&
    !sourceAttributionWarningMatches(applied, projectLegacySourceAttribution(row.source, resolution.data.request.decisions?.fonte).warning)) {
    discrepancy('avisos_da_linha_divergentes');
  }
  // A resolução integral do INSERT vincula o pedido antes de ler sua projeção.
  const appliedAudit = importUnitAudit(applied, data);
  const skippedAudit = imported.result === 'skipped' ? importUnitAudit(imported, data) : undefined;
  const auditDifferences = Number(!appliedAudit.valid) + Number(skippedAudit?.valid === false);
  if (auditDifferences) {
    discrepancy('auditoria_da_unidade_divergente', auditDifferences);
    return;
  }
  checkLiveProjection(row, app, resolution.data, applied, latest, data, count, discrepancy);
  checkEvidence(row, app, applied, resolution.data, captured.data, latest, appliedAudit.request, data, count, discrepancy);
}

function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  // A coluna timestamptz muda a apresentação do fuso. A fração continua relevante.
  const fraction = (value: string) => (value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '').padEnd(9, '0');
  return Date.parse(a) === Date.parse(b) && fraction(a) === fraction(b);
}

function checkReview(review: Review, data: ExportIndex): 'verified' | 'divergent' | 'unverifiable' {
  const parsed = reviewProvenanceSchema.safeParse(review.importProvenance);
  if (!parsed.success) return 'divergent';
  const { runId, sourceFileId, sourceHash, importerVersion, importedAt, ...metadata } = parsed.data;
  const run = data.allRuns.get(runId);
  const file = data.allFiles.get(sourceFileId);
  const unit = reviewUnitSchema.safeParse(record(run?.unitState)?.review);
  const batch = data.batches.get(review.batchId);
  const members = data.membersByBatch.get(review.batchId) ?? [];
  if (!run || !file || !batch || !unit.success || unit.data.result.reviewId !== review.id || unit.data.result.batchId !== batch.id ||
    run.importerVersion !== importerVersion || file.importRunId !== run.id || file.fileHash !== sourceHash || !/\.md$/i.test(file.fileName) ||
    review.originalMarkdown !== Buffer.from(file.originalBytesBase64, 'base64').toString('utf8') || review.narrative !== review.originalMarkdown ||
    review.type !== 'original' || review.versionNumber !== 1 || review.predecessorId !== null || review.decisions.length !== 0 ||
    !equal(review.snapshot.populationIds, review.populationIds) || !equal(review.snapshot.eventIds, review.eventIds) ||
    batch.target !== 30 || batch.status !== 'closed' || batch.cycleId !== record(run.unitState)?.cycleId ||
    members.length !== review.populationIds.length || members.length !== 30 ||
    members.some((member) => member.allocation !== 'counted' || !member.eligible) ||
    new Set(review.populationIds).size !== members.length || new Set(members.map((member) => member.capturedOrder)).size !== members.length) return 'divergent';
  const closedAt = metadata.snapshotTimeMeaning === 'historical_instant' ? review.snapshot.asOf : null;
  if (closedAt === null ? review.closedAt !== null : !sameInstant(review.closedAt, closedAt)) return 'divergent';
  const memberByApp = new Map(members.map((member) => [member.applicationId, member]));
  const imports = (data.filesByRun.get(runId) ?? []).filter((item) => /\.csv$/i.test(item.fileName)).flatMap((item) => data.rowsByFile.get(item.id) ?? []);
  const captured = group(imports, (item) => item.targetApplicationId);
  const reviewAudit = (data.auditByEntity.get('review_versions/' + review.id) ?? []).filter((entry) => entry.actor.kind === 'import' && entry.operation === 'insert');
  // O horário de captura é um dado do importador e não uma data histórica presumida.
  if (reviewAudit.length > 1) return 'divergent';
  if (reviewAudit.length === 1) {
    const original = record(reviewAudit[0]!.afterData);
    if (!original || !equal(original.snapshot, review.snapshot) || !equal(original.import_provenance, review.importProvenance) ||
      original.original_markdown !== review.originalMarkdown || !equal(original.population_ids, review.populationIds) ||
      !equal(original.event_ids, review.eventIds)) return 'divergent';
  } else if (!sameInstant(review.createdAt, importedAt)) return 'unverifiable';
  const populationIds = new Set(review.populationIds);
  const externalIds = new Set(review.snapshot.externalResultApplicationIds ?? []);
  const externalEventIds = new Set(review.snapshot.externalResultEventIds ?? []);
  if (review.snapshot.externalResultApplicationIds?.length !== undefined && externalIds.size !== review.snapshot.externalResultApplicationIds.length ||
    review.snapshot.externalResultEventIds?.length !== undefined && externalEventIds.size !== review.snapshot.externalResultEventIds.length ||
    [...externalIds].some((id) => populationIds.has(id) || !data.appsById.has(id)) ||
    review.eventIds.some((id) => !populationIds.has(data.eventsById.get(id)?.applicationId ?? '') || externalEventIds.has(id)) ||
    [...externalEventIds].some((id) => !externalIds.has(data.eventsById.get(id)?.applicationId ?? '')) ||
    new Set(review.eventIds).size !== review.eventIds.length) return 'divergent';
  const population = [];
  for (const applicationId of review.populationIds) {
    const app = data.appsById.get(applicationId);
    const member = memberByApp.get(applicationId);
    const mapped = captured.get(applicationId) ?? [];
    if (!app?.legacyId || !member || mapped.length > 1) return 'divergent';
    const unit = unitResultSchema.safeParse(mapped[0]?.unitResult);
    if (!unit.success || unit.data.applicationId !== applicationId) return 'unverifiable';
    population.push({ legacyId: app.legacyId, capturedOrder: member.capturedOrder, expectedVersion: unit.data.version });
  }
  const requestHash = transferHash({ runId, batchNumber: batch.batchNumber, members: population, markdownFile: file.fileName,
    closedAt, snapshot: review.snapshot, ...metadata });
  return requestHash === unit.data.requestHash ? 'verified' : 'divergent';
}

function reviewSourceKey(review: Review, data: ExportIndex) {
  const sourceFileId = record(review.importProvenance)?.sourceFileId;
  const file = typeof sourceFileId === 'string' ? data.allFiles.get(sourceFileId) : undefined;
  return file && file.fileName + '/' + file.fileHash;
}

function inheritsReviewClose(parent: Review, successor: Review) {
  if (parent.closedAt == null) return successor.closedAt === parent.closedAt;
  // O serviço reinsere o timestamptz do pai usando um Date com precisão de milissegundos.
  return sameInstant(successor.closedAt, new Date(parent.closedAt).toISOString());
}

function checkReviewSuccessors(related: Review[], linked: Review | undefined, verified: Set<string>, data: ExportIndex,
  count: Count, discrepancy: Count) {
  const versionKey = (review: Review) => review.batchId + '/' + review.versionNumber;
  const byVersion = group(related, versionKey);
  const successors = related.filter((review) => review.type !== 'original' && review.id !== linked?.id)
    .sort((a, b) => a.versionNumber - b.versionNumber);
  // O pai já foi conferido ao alcançar a versão seguinte, qualquer que seja a ordem de UUIDs.
  for (const review of successors) {
    const parent = data.reviewsById.get(review.predecessorId ?? '');
    if (!parent || !verified.has(parent.id) || parent.batchId !== review.batchId || parent.versionNumber + 1 !== review.versionNumber ||
      byVersion.get(versionKey(review))!.length !== 1 || !equal(parent.importProvenance, review.importProvenance) ||
      parent.originalMarkdown !== review.originalMarkdown || !inheritsReviewClose(parent, review) ||
      !equal(parent.populationIds, review.populationIds) ||
      !equal(review.snapshot.eventIds, review.eventIds) || !review.reason?.trim() || !review.evidenceId || !data.evidence.has(review.evidenceId) ||
      // A retificação ordena os IDs no snapshot. A revisão herda o snapshot inteiro do pai.
      review.type === 'rectification' && !equal(review.snapshot.populationIds, [...parent.populationIds].sort()) ||
      review.type === 'revision' && (!equal(parent.snapshot, review.snapshot) || parent.calculationVersion !== review.calculationVersion)) {
      discrepancy('cadeia_de_revisao_divergente');
      continue;
    }
    verified.add(review.id);
    count('versoes_posteriores_de_revisao');
  }
}

function checkReviews(manifest: PreviewManifest, run: Data<'import_runs'>, data: ExportIndex,
  reviewRequired: boolean | undefined, count: Count, discrepancy: Count) {
  const unit = reviewUnitSchema.safeParse(record(run.unitState)?.review);
  const selected = new Set(manifest.sources.filter((source) => /\.md$/i.test(source.name)).map((source) => source.name + '/' + source.sha256));
  const matched = new Set<string>();
  const linked = unit.success ? data.reviewsById.get(unit.data.result.reviewId) : undefined;
  if (reviewRequired && !linked || record(run.unitState)?.review !== undefined && !linked) discrepancy('revisao_sem_vinculo_verificavel');
  const keys = new Map(data.reviews.map((review) => [review.id, reviewSourceKey(review, data)]));
  const batchIds = new Set(data.reviews.filter((review) => review.id === linked?.id || selected.has(keys.get(review.id) ?? ''))
    .map((review) => review.batchId));
  const related = data.reviews.filter((review) => batchIds.has(review.batchId));
  count('revisoes_fora_do_conjunto', data.reviews.length - related.length);
  const originals = related.filter((review) => review.type === 'original' || review.id === linked?.id);
  const bySource = group(originals.filter((review) => selected.has(keys.get(review.id) ?? '')), (review) => keys.get(review.id));
  const byBatch = group(originals, (review) => review.batchId);
  const competing = new Set<string>();
  for (const claims of [...bySource.values(), ...byBatch.values()]) {
    if (claims.length < 2 || claims.every((claim) => competing.has(claim.id))) continue;
    discrepancy('revisao_com_mapeamento_duplicado', claims.length - 1);
    for (const claim of claims) competing.add(claim.id);
  }
  const verified = new Set<string>();
  for (const review of originals) {
    const key = keys.get(review.id);
    if (!key || !selected.has(key) || review.id === linked?.id && record(review.importProvenance)?.runId !== run.id) {
      discrepancy('revisao_historica_divergente');
      continue;
    }
    const result = checkReview(review, data);
    if (result === 'verified') {
      matched.add(key);
      verified.add(review.id);
      count('revisoes_verificadas');
    } else discrepancy(result === 'divergent' ? 'revisao_historica_divergente' : 'revisao_sem_prova_da_projecao');
  }
  checkReviewSuccessors(related, linked, verified, data, count, discrepancy);
  if (selected.size && matched.size === 0 && !reviewRequired && !linked) discrepancy('revisao_sem_vinculo_verificavel');
  else count('controles_markdown_somente_no_arquivo', selected.size - matched.size);
}

function reconcile(manifest: PreviewManifest, snapshot: Snapshot): Result {
  const counts: Record<string, number> = { arquivos: manifest.sources.length, registros: manifest.parsed.rows.length };
  const discrepancies: Record<string, number> = {};
  let issueCount = 0;
  const count: Count = (key, size = 1) => { if (size > 0) counts[key] = (counts[key] ?? 0) + size; };
  const discrepancy: Count = (key, size = 1) => {
    if (size > 0) { discrepancies[key] = (discrepancies[key] ?? 0) + size; issueCount += size; }
  };
  const result = (): Result => ({ exitCode: Object.keys(discrepancies).length ? 2 : 0, counts, discrepancies });
  count('avisos_na_fonte', manifest.parsed.issues.length);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const data = privateExportIndex(snapshot);
  const runs = data.runs.filter((run) => run.sourceSetHash === manifest.sourceSetHash && run.importerVersion === manifest.importerVersion);
  if (runs.length !== 1) { discrepancy(runs.length ? 'lote_de_importacao_duplicado' : 'lote_de_importacao_ausente'); return result(); }
  const run = runs[0]!;
  const warnings = manifest.parsed.issues.map((issue) => ({ row: issue.row, code: issue.code }));
  const runWarnings = [...new Set(warnings.map((issue) => issue.code))].sort();
  if (!equal(runWarnings, [...run.pendingIssues].sort())) discrepancy('avisos_do_lote_divergentes');
  const warningsByRow = group(warnings, (issue) => issue.row);
  const completed = completedSchema.safeParse(record(run.unitState)?.completed);
  if (run.status !== 'completed' || !completed.success || completed.data.runId !== run.id || completed.data.rowCount !== manifest.parsed.rows.length) {
    discrepancy('conclusao_da_importacao_divergente');
  }
  count('lotes_historicos_fora_do_conjunto', data.runs.length - 1);
  const files = group(data.filesByRun.get(run.id) ?? [], (file) => file.fileName);
  let csv: Data<'source_files'> | undefined;
  for (const source of manifest.sources) {
    const matches = files.get(source.name) ?? [];
    files.delete(source.name);
    if (matches.length !== 1) { discrepancy(matches.length ? 'arquivo_arquivado_duplicado' : 'arquivo_arquivado_ausente'); continue; }
    const file = matches[0]!;
    const bytes = Buffer.from(file.originalBytesBase64, 'base64');
    let decoded: string | undefined;
    try { decoded = decoder.decode(bytes); } catch { /* Uma fonte ilegível fica pendente. */ }
    if (file.fileHash !== source.sha256 || bytes.length !== source.size || file.originalText !== decoded) {
      discrepancy('arquivo_arquivado_divergente');
      continue;
    }
    if (/\.csv$/i.test(source.name)) csv = file;
    count('arquivos_verificados');
  }
  for (const unmatched of files.values()) discrepancy('arquivo_inesperado_no_lote', unmatched.length);
  checkReviews(manifest, run, data, completed.data?.reviewRequired, count, discrepancy);
  count('candidaturas_nativas', data.appsByLegacy.get(null)?.length ?? 0);
  const sourceKeys = new Set(manifest.parsed.rows.map((row) => row.legacyId));
  const previouslyCaptured = new Set(manifest.diff.filter((item) => item.kind === 'source_missing').map((item) => item.legacyId));
  for (const key of previouslyCaptured) if (!data.appsByLegacy.has(key)) discrepancy('id_removido_sem_historico');
  for (const app of data.apps) {
    if (app.legacyId === null || sourceKeys.has(app.legacyId)) continue;
    discrepancy(previouslyCaptured.has(app.legacyId) ? 'id_legado_removido_da_fonte' : 'id_legado_fora_da_fonte_final');
  }
  if (!csv) return result();
  const exportRows = data.rowsByFile.get(csv.id) ?? [];
  const rowsByPosition = group(exportRows, (row) => row.rowNumber);
  for (const [position, row] of manifest.parsed.rows.entries()) {
    if (row.submissionStatus) count('status_original_' + row.submissionStatus);
    if (row.submittedDate.precision === 'unknown') count('datas_de_envio_desconhecidas');
    const matches = rowsByPosition.get(position + 2) ?? [];
    rowsByPosition.delete(position + 2);
    if (matches.length !== 1) { discrepancy(matches.length ? 'mapeamento_duplicado' : 'linha_ausente'); continue; }
    const imported = matches[0]!;
    if (imported.legacyId !== row.legacyId) { discrepancy('ordem_original_divergente'); continue; }
    if (imported.originalText !== row.raw || imported.rowHash !== row.rawRowHash) { discrepancy('texto_original_divergente'); continue; }
    const before = issueCount;
    reconcileRow(row, imported, run.id, (warningsByRow.get(position + 2) ?? []).map((issue) => issue.code), data, count, discrepancy);
    if (before === issueCount) count('registros_verificados');
  }
  for (const unmatched of rowsByPosition.values()) discrepancy('linha_inesperada_no_lote', unmatched.length);
  return result();
}

async function readLocalManifest(file: string): Promise<PreviewManifest> {
  const input = path.resolve(file);
  if (path.basename(input) !== 'manifest.json') throw new Error();
  const directory = await realpath(path.dirname(input));
  const target = path.join(directory, 'manifest.json');
  const worktree = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const gitCommon = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repository = await realpath(path.dirname(path.resolve(worktree, gitCommon)));
  for (const scope of new Set([worktree, repository])) {
    const relative = path.relative(scope, directory);
    if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) throw new Error();
  }
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SNAPSHOT_BYTES) throw new Error();
  const handle = await open(target, 'r');
  let manifest: PreviewManifest;
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error();
    const bytes = Buffer.alloc(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) throw new Error();
      position += bytesRead;
    }
    const after = await lstat(target);
    if ((await handle.read(Buffer.alloc(1), 0, 1, position)).bytesRead || after.ino !== opened.ino ||
      after.dev !== opened.dev || after.size !== opened.size || after.isSymbolicLink() || await realpath(target) !== target) throw new Error();
    manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } finally {
    await handle.close();
  }
  // Somente a pasta real da entrada pode fornecer sources/ e diff.json.
  if (manifest.snapshotDirectory !== directory || new Set(manifest.sources.map((source) => source.name.toLowerCase())).size !== manifest.sources.length) throw new Error();
  await verifyPreviewArtifact(manifest);
  return manifest;
}

const invalid = (category: string): Result => ({ exitCode: 1, counts: {}, discrepancies: { [category]: 1 } });

export async function reconcileCutoverFiles(manifestFile: string, exportFile: string): Promise<Result> {
  let manifest: PreviewManifest;
  try { manifest = await readLocalManifest(manifestFile); }
  catch { return invalid('manifesto_invalido'); }
  if (manifest.parsed.blocked) return invalid('manifesto_bloqueado');
  let snapshot: Snapshot;
  try { snapshot = await readPrivateSnapshot(exportFile); }
  catch { return invalid('exportacao_invalida'); }
  return reconcile(manifest, snapshot);
}

async function main(args: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!['--manifest', '--export'].includes(key) || flags.has(key) || !value || value.startsWith('--')) break;
    flags.set(key, value);
  }
  const manifest = flags.get('--manifest');
  const exportFile = flags.get('--export');
  if (!manifest || !exportFile || args.length !== 4) {
    console.error('Uso de cutover:check com --manifest <manifesto-privado> e --export <json-privado>.');
    process.exitCode = 1;
    return;
  }
  let result: Result;
  try { result = await reconcileCutoverFiles(manifest, exportFile); }
  catch { result = invalid('falha_na_conferencia'); }
  const state = result.exitCode === 0 ? 'PASS' : result.exitCode === 2 ? 'PENDENTE' : 'FALHA';
  console.log(state + ' na conferência local dos artefatos. ' + (result.counts.registros ?? 0) + ' registros no manifesto.');
  for (const [category, number] of Object.entries({ ...result.counts, ...result.discrepancies }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    console.log(category + ' ' + number);
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
