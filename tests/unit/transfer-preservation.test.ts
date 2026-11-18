import { describe, expect, it } from 'vitest';
import { commandSchema } from '../../shared/commands';
import { MAX_SOURCE_ARCHIVE_BYTES, reviewSnapshotSchema, transferEntitySchema } from '../../shared/transfer';
import { unknownDate } from '../fixtures/career';

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
