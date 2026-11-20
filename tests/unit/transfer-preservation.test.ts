import { describe, expect, it } from 'vitest';
import { commandSchema } from '../../shared/commands';
import { buildReviewSnapshot } from '../../domain/cycles';
import { buildSnapshot, TransferError } from '../../domain/export';
import type { AnalyticsEvent, AnalyticsRow } from '../../shared/analytics';
import { MAX_SOURCE_ARCHIVE_BYTES, reviewSnapshotSchema, transferEntitySchema, type TransferEntity } from '../../shared/transfer';
import { appFixture, unknownDate } from '../fixtures/career';

const id = '00000000-0000-4000-8000-000000000101';
const instant = '2026-11-15T12:00:00Z';
const base = { id, version: 1, createdAt: instant, updatedAt: instant };
const metric = { numerator: 0, denominator: 0, ratio: null, applicationIds: [] };
const fileData = { ...base, importRunId: id, fileName: ' arquivo sintético.bin ', fileHash: 'a'.repeat(64), originalText: null };

describe('preservação exata das transferências históricas', () => {
  it('preserva baseline e decisões de unidades importadas e estado de retomada', () => {
    const imported = { formatVersion: 1, table: 'import_rows', data: { ...base, sourceFileId: id, rowNumber: 2, rowHash: 'a'.repeat(64), originalText: 'texto fictício\r\n', legacyId: 'V901', targetApplicationId: id, result: 'skipped', pendingIssues: [], appliedTargetVersion: 3, resolution: { decisions: { observacoes: 'current' } }, unitResult: { applicationId: id, version: 4, result: 'skipped' } } };
    expect(transferEntitySchema.parse(imported)).toEqual(imported);
    const run = { formatVersion: 1, table: 'import_runs', data: { ...base, importerVersion: 'legacy-preview/2', sourceSetHash: 'a'.repeat(64), status: 'running', pendingIssues: [], unitState: { cycleId: id, completed: { rowCount: 1 } } } };
    expect(transferEntitySchema.parse(run)).toEqual(run);
  });
  it('preserva auditoria de fontes grandes em todos os locais espelhados', () => {
    // Somente os campos conhecidos da fonte recebem o limite ampliado.
    const source = 'x'.repeat(50_001);
    expect(transferEntitySchema.safeParse({ formatVersion: 1, table: 'source_files', data: { ...fileData, originalBytesBase64: Buffer.from(source).toString('base64'), originalText: source } }).success).toBe(true);
    const history = { original_text: source, original_bytes: '\\x' + Buffer.from(source).toString('hex') };
    const row = { formatVersion: 1, table: 'audit_log', data: { id, actor: { kind: 'import', id }, source: 'legacy-preview/2', occurredAt: instant, entityType: 'source_files', entityId: id, operation: 'update', beforeData: history, afterData: history, diff: { original_text: { before: source, after: source }, original_bytes: { before: history.original_bytes, after: history.original_bytes } }, requestId: id, createdAt: instant } };
    expect(transferEntitySchema.parse(row)).toEqual(row);
    for (const invalid of ['\\xgg', '\\x0', '00', '\\x' + '00'.repeat(MAX_SOURCE_ARCHIVE_BYTES + 1)]) {
      expect(transferEntitySchema.safeParse({ ...row, data: { ...row.data, afterData: { original_bytes: invalid } } }).success).toBe(false);
    }
    expect(transferEntitySchema.safeParse({ ...row, data: { ...row.data, afterData: { unrelated: source } } }).success).toBe(false);
    expect(transferEntitySchema.safeParse({ ...row, data: { ...row.data, entityType: 'applications' } }).success).toBe(false);
  });
  it('mantém o teto de bytes UTF-8 para textos de fonte também na auditoria', () => {
    const oversized = 'é'.repeat(MAX_SOURCE_ARCHIVE_BYTES / 2 + 1);
    const row = { formatVersion: 1, table: 'audit_log', data: { id, actor: { kind: 'owner', id }, source: 'fixture', occurredAt: instant, entityType: 'source_files', entityId: id, operation: 'insert', beforeData: null, afterData: { original_text: oversized }, diff: {}, requestId: id, createdAt: instant } };
    expect(transferEntitySchema.safeParse(row).success).toBe(false);
    expect(transferEntitySchema.safeParse({ ...row, data: { ...row.data, afterData: null, diff: { original_text: { before: null, after: oversized } } } }).success).toBe(false);
  });
  it('preserva chaves com espaços sem colisão, inclusive em objetos aninhados', () => {
    const history = { collision: ' first ', ' collision ': ' second ', nested: [{ collision: ' value ', ' collision ': ' other value ' }] };
    const row = { formatVersion: 1, table: 'audit_log', data: { id, actor: { kind: 'import', id: ' imported actor ' }, source: ' source ', occurredAt: instant, entityType: ' application ', entityId: id, operation: ' import ', beforeData: history, afterData: history, diff: history, requestId: id, createdAt: instant } };
    expect(transferEntitySchema.parse(row)).toEqual(row);
  });
  it('preserva chaves JSON vazias e compostas apenas por espaços', () => {
    const history = { '': ' vazio ', ' ': ' espaço ' };
    const row = { formatVersion: 1, table: 'audit_log', data: { id, actor: { kind: 'owner', id }, source: 'test', occurredAt: instant, entityType: 'application', entityId: id, operation: 'import', beforeData: history, afterData: null, diff: {}, requestId: id, createdAt: instant } };
    expect(transferEntitySchema.parse(row)).toEqual(row);
  });
  it('preserva chaves de métricas que diferem apenas por espaços', () => {
    const snapshot = { schemaVersion: 1, asOf: instant, period: null, populationIds: [], eventIds: [], metrics: { collision: metric, ' collision ': { ...metric, numerator: 1 } } };
    expect(reviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
  it('preserva __proto__, constructor e prototype próprios sem alterar protótipos', () => {
    const history = JSON.parse('{"__proto__":{"original":"keep","polluted":"never"},"constructor":"keep","prototype":"keep","nested":[{"__proto__":{"original":"nested"}}]}');
    const row = { formatVersion: 1, table: 'audit_log', data: { id, actor: { kind: 'owner', id }, source: 'test', occurredAt: instant, entityType: 'application', entityId: id, operation: 'import', beforeData: history, afterData: history, diff: history, requestId: id, createdAt: instant } };
    const parsed = transferEntitySchema.parse(row);
    expect(parsed).toEqual(row);
    if (parsed.table === 'audit_log') {
      expect(Object.getOwnPropertyDescriptor(parsed.data.beforeData, '__proto__')?.value).toEqual({ original: 'keep', polluted: 'never' });
      expect(Object.getPrototypeOf(parsed.data.beforeData)).toBe(Object.prototype);
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
  it('preserva as mesmas chaves próprias no registro de métricas', () => {
    const metrics = JSON.parse(`{"__proto__":${JSON.stringify(metric)},"constructor":${JSON.stringify(metric)},"prototype":${JSON.stringify(metric)}}`);
    const snapshot = { schemaVersion: 1, asOf: instant, period: null, populationIds: [], eventIds: [], metrics };
    const parsed = reviewSnapshotSchema.parse(snapshot);
    expect(parsed).toEqual(snapshot);
    expect(Object.getOwnPropertyDescriptor(parsed.metrics, '__proto__')?.value).toEqual(metric);
    expect(Object.getPrototypeOf(parsed.metrics)).toBe(Object.prototype);
  });
  it('preserva chaves próprias também na proveniência e evidências de revisão', () => {
    const history = JSON.parse('{"__proto__":{"keep":"original"},"constructor":"literal"}');
    const snapshot = { schemaVersion: 1, asOf: instant, period: null, populationIds: [], eventIds: [], metrics: {}, eventEvidence: history, coverage: history };
    expect(reviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
  it.each([
    JSON.parse(`{"__proto__":${JSON.stringify('x'.repeat(50_001))}}`),
    JSON.parse(`{${JSON.stringify('x'.repeat(201))}:"value"}`),
    Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [String(index), 'value'])),
    Object.fromEntries([['__proto__', undefined]]),
    Object.fromEntries([['__proto__', Number.POSITIVE_INFINITY]]),
  ])('recusa valores ou limites inválidos em registros históricos', (history) => {
    const row = { formatVersion: 1, table: 'audit_log', data: { id, actor: { kind: 'owner', id }, source: 'test', occurredAt: instant, entityType: 'application', entityId: id, operation: 'import', beforeData: history, afterData: null, diff: {}, requestId: id, createdAt: instant } };
    expect(transferEntitySchema.safeParse(row).success).toBe(false);
  });
  it('valida também campos extras de métricas sob a chave __proto__', () => {
    const metrics = JSON.parse(`{"__proto__":${JSON.stringify({ ...metric, unexpected: 'invalid' })}}`);
    expect(reviewSnapshotSchema.safeParse({ schemaVersion: 1, asOf: instant, period: null, populationIds: [], eventIds: [], metrics }).success).toBe(false);
  });
  const records = [
    { table: 'opportunities', data: { ...base, company: ' Company ', title: ' Title ', platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'desconhecido', seniority: null, modality: null, description: ' description\n ', stack: ['.NET', ' .NET '] } },
    { table: 'resume_refs', data: { ...base, label: ' Resume ', stack: ['.NET', ' .NET '], language: ' pt-BR ', localRef: ' local ref ' } },
    { table: 'applications', data: { ...base, opportunityId: id, legacyId: null, displayId: 'N000001', track: ' track ', applicationInstance: ' initial ', submissionStatus: 'nao_confirmado', submittedDate: unknownDate, stage: 'desconhecida', discoveryChannel: null, submissionPlatform: null, notes: ' note ', cycleRelation: 'unknown', cycleOrder: null, countingEligible: true, archivedAt: null, canonicalApplicationId: null, legacyRegisteredDate: unknownDate, legacyResumeText: ' resume text ' } },
    { table: 'tasks', data: { ...base, applicationId: id, contactId: null, title: ' Preparar entrevista ', dueDate: unknownDate, completedDate: unknownDate, status: 'pending' } },
    { table: 'events', data: { ...base, kind: 'avaliacao', state: 'informado', occurredDate: unknownDate, resultText: ' result ', scoreValue: 10, scoreUnit: ' points ', sourceText: ' original source ', applicationId: id, evidenceId: null, supersedesEventId: null } },
    { table: 'links', data: { ...base, originalUrl: ' local ref ', comparisonUrl: null, kind: ' arquivo ', isLocal: true, isPrivate: true, opportunityId: id, applicationId: null, contactId: null } },
    { table: 'import_runs', data: { ...base, importerVersion: ' version 1 ', sourceSetHash: 'a'.repeat(64), status: 'completed', pendingIssues: [' issue '] } },
    { table: 'opportunity_identities', data: { ...base, opportunityId: id, provider: ' provider ', tenant: ' tenant ', identityKind: 'job_code', identityValue: ' /Job/AbC ', verificationEvidenceId: null } },
  ];
  it.each(records)('preserva textos e rótulos originais de $table', (record) => {
    const row = { formatVersion: 1, ...record };
    expect(transferEntitySchema.parse(row)).toEqual(row);
  });
  it('mantém a normalização restrita aos comandos interativos', () => {
    const command = commandSchema.parse({ operation: 'save_task', target: { clientId: id }, parents: { application: { id, expectedVersion: 1 }, contact: null }, data: { title: ' Preparar entrevista ', dueDate: unknownDate } });
    expect(command.operation).toBe('save_task');
    if (command.operation === 'save_task') expect(command.data.title).toBe('Preparar entrevista');
  });
});

describe('limites do arquivo-fonte codificado em base64', () => {
  it.each([MAX_SOURCE_ARCHIVE_BYTES - 1, MAX_SOURCE_ARCHIVE_BYTES])('aceita %i bytes válidos e preserva a codificação', (bytes) => {
    const originalBytesBase64 = Buffer.alloc(bytes).toString('base64');
    const row = { formatVersion: 1, table: 'source_files', data: { ...fileData, originalBytesBase64 } };
    const parsed = transferEntitySchema.parse(row);
    expect(parsed.table).toBe('source_files');
    if (parsed.table === 'source_files') expect(parsed.data.originalBytesBase64).toBe(originalBytesBase64);
  });
  it('recusa um byte além do limite sem lançar exceção', () => {
    const originalBytesBase64 = Buffer.alloc(MAX_SOURCE_ARCHIVE_BYTES + 1).toString('base64');
    expect(transferEntitySchema.safeParse({ formatVersion: 1, table: 'source_files', data: { ...fileData, originalBytesBase64 } }).success).toBe(false);
  });
  it.each(['A===', 'AA=A', 'A', 'AAA', 'AAAA=', 'AAAA====', 'AA==AA==', 'AA*A', '\nAAA', 'AA A'])('recusa alfabeto/padding inválido %j sem lançar exceção', (originalBytesBase64) => {
    expect(transferEntitySchema.safeParse({ formatVersion: 1, table: 'source_files', data: { ...fileData, originalBytesBase64 } }).success).toBe(false);
  });
});
describe('transferência das correções de candidatura', () => {
  const id = '00000000-0000-4000-8000-000000000101';
  const createdAt = '2026-11-15T12:00:00Z';
  const base = { id, version: 1, createdAt, updatedAt: createdAt };
  it('preserva associações inativas, pendência e identidade de CV/evidência', () => {
    const records = [
      { table: 'application_resumes', data: { ...base, applicationId: id, resumeId: id, isActive: false } },
      { table: 'batches', data: { ...base, cycleId: id, batchNumber: 1, status: 'closed', target: 30, rectificationPending: true } },
      ...(['resume_ref', 'evidence'] as const).map((entityType) => ({ table: 'creation_requests', data: { id, createdAt, clientId: id, payloadHash: 'a'.repeat(64), entityType, resultApplicationId: null, resultContactId: null, resultTaskId: null, resultEventId: null, resultResumeId: entityType === 'resume_ref' ? id : null, resultEvidenceId: entityType === 'evidence' ? id : null } })),
    ];
    for (const row of records) expect(transferEntitySchema.parse({ formatVersion: 1, ...row })).toEqual({ formatVersion: 1, ...row });
  });
});

type ReviewRow = Extract<TransferEntity, { table: 'review_versions' }>;
function frozenReviewTransfer() {
  const identifier = (sequence: number) => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const [owner, opportunityId, cycleId, batchId, reviewId] = [1, 2, 3, 4, 5].map(identifier) as [string, string, string, string, string];
  const application = (n: number, cycleOrder: number | null, canonicalApplicationId: string | null = null): AnalyticsRow => ({
    ...appFixture({ id: identifier(n), displayId: `N00000${n}`, cycleOrder, countingEligible: !canonicalApplicationId, canonicalApplicationId }),
    company: null, title: null, seniority: null, modality: null, batchIds: canonicalApplicationId ? [] : [batchId],
  });
  const member = application(6, 7), second = application(7, 6), alias = application(8, null, member.id);
  const assessment: AnalyticsEvent = {
    id: identifier(21), applicationId: alias.id, kind: 'avaliacao', state: 'concluido',
    recordedAt: '2026-11-15T11:30:00.123456Z', occurredDate: { precision: 'instant', certainty: 'exact', value: '2026-11-14T15:00:00.123456Z' },
    resultText: ' Desempenho original.\r\n', scoreValue: 80, scoreUnit: ' pontos ', sourceText: null, supersedesEventId: null,
  };
  const independent: AnalyticsEvent = { ...assessment, id: identifier(22), occurredDate: unknownDate };
  const correction: AnalyticsEvent = {
    ...assessment, id: identifier(23), kind: 'nota', state: 'informado', occurredDate: unknownDate,
    resultText: 'Evidência corrigida.', scoreValue: null, scoreUnit: null, sourceText: ' Texto original. ', supersedesEventId: assessment.id,
  };
  const physicalEvents = [assessment, independent, correction];
  const populationIds = [second.id, member.id];
  const snapshot = reviewSnapshotSchema.parse(buildReviewSnapshot([member, second, alias], physicalEvents, populationIds, instant));
  const review: ReviewRow = {
    formatVersion: 1, table: 'review_versions', data: { ...base, id: reviewId, batchId, versionNumber: 1, type: 'original',
      snapshot, populationIds, eventIds: snapshot.eventIds, calculationVersion: 'metrics-v1/review-v2', closedAt: instant,
      narrative: null, decisions: [], predecessorId: null, reason: null, evidenceId: null, originalMarkdown: null, importProvenance: null },
  };
  const entities: TransferEntity[] = [
    { formatVersion: 1, table: 'opportunities', data: { ...base, id: opportunityId, company: null, title: null, kind: 'vaga', platform: null, tenant: null, jobCode: null, jobKey: null, seniority: null, modality: null, description: null, stack: [] } },
    { formatVersion: 1, table: 'cycles', data: { ...base, id: cycleId, resetDate: unknownDate, resetMarker: null, nextOrder: 8, isCurrent: true } },
    { formatVersion: 1, table: 'batches', data: { ...base, id: batchId, cycleId, batchNumber: 1, status: 'closed', target: 2, rectificationPending: false } },
    ...[second, member].map((row, index): TransferEntity => ({
      formatVersion: 1, table: 'batch_members', data: { ...base, id: identifier(31 + index), batchId, applicationId: row.id, capturedOrder: row.cycleOrder!, allocation: 'counted', eligible: true },
    })),
    ...[member, second, alias].map((row): TransferEntity => ({
      formatVersion: 1, table: 'applications', data: { ...base, id: row.id, displayId: row.displayId, opportunityId, legacyId: null,
        track: null, applicationInstance: `fictícia-${row.displayId}`, submissionStatus: row.submissionStatus, submittedDate: row.submittedDate,
        stage: row.stage, discoveryChannel: null, submissionPlatform: null, notes: null, cycleRelation: row.cycleRelation, cycleOrder: row.cycleOrder,
        countingEligible: row.countingEligible, archivedAt: null, canonicalApplicationId: row.canonicalApplicationId, legacyRegisteredDate: unknownDate, legacyResumeText: null },
    })),
    ...physicalEvents.map(({ recordedAt, ...event }): TransferEntity => ({
      formatVersion: 1, table: 'events', data: { ...base, ...event, createdAt: recordedAt, evidenceId: null },
    })),
    review,
  ];
  return { review, assessment, correction, independent, alias, rebuild: () => buildSnapshot(owner, entities, instant) };
}

describe('coerência das projeções nativas de revisão v2', () => {
  it('preserva a ordem capturada e o alias físico de uma correção, com instantes equivalentes', () => {
    const { review, rebuild, assessment, correction, alias } = frozenReviewTransfer();
    const frozen = review.data.snapshot.events!.find((event) => event.id === assessment.id)!;
    frozen.recordedAt = '2026-11-15T08:30:00.123456-03:00';
    frozen.occurredDate = { precision: 'instant', certainty: 'exact', value: '2026-11-14T12:00:00.123456-03:00' };
    const retained = rebuild().entities.find((row) => row.table === 'review_versions');
    expect(retained).toEqual(review);
    expect(review.data.populationIds).toEqual([...review.data.snapshot.populationIds].reverse());
    expect(review.data.snapshot.events).toContainEqual(expect.objectContaining({ id: correction.id, applicationId: alias.id, supersedesEventId: assessment.id }));
    expect(frozen).toMatchObject({ resultText: ' Desempenho original.\r\n', scoreUnit: ' pontos ', sourceText: null });
  });

  it.each([
    ['registros internos ausentes', (review: ReviewRow['data']) => { review.snapshot.populationIds = []; }],
    ['registros internos duplicados', (review: ReviewRow['data']) => { review.snapshot.populationIds.push(review.snapshot.populationIds[0]!); }],
    ['registros externos duplicados', (review: ReviewRow['data']) => { review.populationIds.push(review.populationIds[0]!); }],
    ['declaração externa rebaixada e histórico ausente', (review: ReviewRow['data']) => {
      review.calculationVersion = 'metrics-v1/review-v1';
      delete review.snapshot.externalEventHistoryIds;
    }],
  ] as const)('recusa transferência reconstituída com %s', (_label, change) => {
    const { review, rebuild } = frozenReviewTransfer();
    change(review.data);
    expect(rebuild).toThrow(TransferError);
  });

  it.each([
    ['classificação e estado divergentes', (event: AnalyticsEvent) => { event.kind = 'nota'; event.state = 'informado'; }],
    ['data de ocorrência divergente', (event: AnalyticsEvent) => { event.occurredDate = unknownDate; }],
    ['certeza da data divergente', (event: AnalyticsEvent) => { event.occurredDate = { precision: 'instant', certainty: 'approximate', value: '2026-11-14T15:00:00.123456Z' }; }],
    ['texto ajustado', (event: AnalyticsEvent) => { event.resultText = event.resultText!.trim(); }],
    ['pontuação divergente', (event: AnalyticsEvent) => { event.scoreValue = 81; }],
    ['unidade ajustada', (event: AnalyticsEvent) => { event.scoreUnit = event.scoreUnit!.trim(); }],
    ['texto vazio em lugar de nulo', (event: AnalyticsEvent) => { event.sourceText = ''; }],
  ] as const)('recusa evento congelado com %s', (_label, change) => {
    const { review, assessment, rebuild } = frozenReviewTransfer();
    change(review.data.snapshot.events!.find((event) => event.id === assessment.id)!);
    expect(rebuild).toThrow(TransferError);
  });

  it.each([true, false])('recusa aresta de correção removida ou redirecionada (%s)', (remove) => {
    const { review, correction, independent, rebuild } = frozenReviewTransfer();
    review.data.snapshot.events!.find((event) => event.id === correction.id)!.supersedesEventId = remove ? null : independent.id;
    expect(rebuild).toThrow(TransferError);
  });

  it.each(['metrics-v1/review-v1', null])('aceita declaração histórica %s e preserva o Markdown', (version) => {
    const { review, rebuild } = frozenReviewTransfer();
    review.data.calculationVersion = version;
    review.data.eventIds = [];
    review.data.snapshot = { schemaVersion: 1, asOf: instant, period: null, populationIds: review.data.populationIds, eventIds: [], metrics: {},
      ...(version ? { calculationVersion: version } : {}) };
    review.data.originalMarkdown = version ? null : '# Revisão original\r\n  Texto histórico.\r\n';
    expect(rebuild().entities.find((row) => row.table === 'review_versions')).toEqual(review);
  });
});
