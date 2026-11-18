import { describe, expect, it } from 'vitest';
import { commandSchema, MAX_COMMAND_BYTES } from '../../shared/commands';
import { dateValueSchema } from '../../shared/model';
import { querySchema } from '../../shared/queries';
import { transferEntitySchema, transferManifestSchema } from '../../shared/transfer';
import { appFixture, day, unknownDate } from '../fixtures/career';

const id = '00000000-0000-4000-8000-000000000101';
const ref = { id, expectedVersion: 1 };
const evidence = { clientId: id, kind: 'relato_usuario', originalText: 'Envio confirmado pelo usuário.', source: null, occurredDate: unknownDate, privateRef: null, localRef: null };
const opportunity = { company: null, title: null, platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'desconhecido', seniority: null, modality: null, description: null, stack: [], identities: [] };
const applicationData = { opportunity, track: null, applicationInstance: 'initial', submissionStatus: 'nao_confirmado', submittedDate: unknownDate, stage: 'desconhecida', cycleRelation: 'unknown', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [], links: [] };
const create = { operation: 'save_application', clientId: id, data: applicationData, evidence: null };
const event = { kind: 'entrevista', state: 'agendado', occurredDate: day('2026-11-10'), resultText: null, scoreValue: null, scoreUnit: null, sourceText: null, evidence: null };
const parents = { application: ref, contact: null };

describe('contratos estritos de domínio', () => {
  it('normaliza UUID interativo sem mudar caixa de rótulos ou histórico transferido', () => {
    const lower = 'abcdef01-abcd-4abc-8abc-abcdef012345'; const upper = lower.toUpperCase();
    const result = commandSchema.parse({ operation: 'update_application', application: { id: upper, expectedVersion: 1 }, changes: {}, opportunityPatch: { opportunity: { id: upper, expectedVersion: 1 }, changes: { title: 'AI Engineer' } } });
    expect(result).toMatchObject({ application: { id: lower }, opportunityPatch: { opportunity: { id: lower }, changes: { title: 'AI Engineer' } } });
    expect(commandSchema.safeParse({ operation: 'invalidate_submission', application: ref, evidence, reason: 'Correção', affectedBatches: [{ id: lower, expectedVersion: 1 }, { id: upper, expectedVersion: 1 }] }).success).toBe(false);
    expect(commandSchema.safeParse({ operation: 'resolve_duplicate', application: { id: lower, expectedVersion: 1 }, canonicalApplication: { id: upper, expectedVersion: 1 }, evidence, reason: 'Mesmo ID' }).success).toBe(false);
    const row = { formatVersion: 1, table: 'creation_requests', data: { id: upper, createdAt: '2026-11-15T12:00:00Z', clientId: upper, payloadHash: 'a'.repeat(64), entityType: 'application', resultApplicationId: upper, resultContactId: null, resultTaskId: null, resultEventId: null } };
    expect(transferEntitySchema.parse(row)).toEqual(row);
  });
  it('preserva desconhecidos e fixture sintética canônica', () => {
    expect(commandSchema.parse(create)).toEqual(create);
    expect(appFixture()).toMatchObject({ id, displayId: 'N000001', submissionStatus: 'confirmado', submittedDate: day('2026-11-10'), stage: 'candidatura_enviada', cycleRelation: 'after_reset', cycleOrder: 1, stack: ['.NET'], version: 1, archivedAt: null });
    expect(appFixture({ countingEligible: false }).countingEligible).toBe(false);
  });
  it.each(['2024-02-29', '2026-11-10', '0001-01-01'])('aceita dia real %s sem convertê-lo', (value) => {
    expect(dateValueSchema.parse(day(value))).toEqual(day(value));
  });
  it.each([
    day('2026-02-29'), day('2026-04-31'), day('0000-01-01'), day('2026-1-1'),
    { precision: 'month', certainty: 'exact', value: '2026-13' },
    { precision: 'year', certainty: 'exact', value: '0000' },
    { precision: 'instant', certainty: 'exact', value: '2026-11-10T12:00:00' },
    { precision: 'instant', certainty: 'exact', value: '2026-11-10T24:00:00Z' },
    { precision: 'unknown', value: null, certainty: 'exact' },
  ])('rejeita data inválida %j', (value) => { expect(dateValueSchema.safeParse(value).success).toBe(false); });
  it.each(['2026-11-10T12:00:00-03:00', '2026-11-10T15:00:00Z'])('preserva instante explícito %s', (value) => {
    expect(dateValueSchema.parse({ precision: 'instant', certainty: 'approximate', value })).toEqual({ precision: 'instant', certainty: 'approximate', value });
  });
  it('recusa owner/actor extra em qualquer objeto', () => {
    for (const extra of [{ ownerId: id }, { actor: { kind: 'owner', id } }]) expect(commandSchema.safeParse({ ...create, ...extra }).success).toBe(false);
    expect(commandSchema.safeParse({ ...create, data: { ...applicationData, opportunity: { ...opportunity, ownerId: id } } }).success).toBe(false);
  });
  it('confirmação exige evidência explícita e preserva relação desconhecida', () => {
    const confirm = { operation: 'confirm_submission', application: ref, submittedDate: day('2026-11-10'), cycleRelation: 'after_reset', evidence };
    expect(commandSchema.safeParse(confirm).success).toBe(true);
    expect(commandSchema.safeParse({ ...confirm, evidence: null }).success).toBe(false);
    expect(commandSchema.safeParse({ ...confirm, cycleRelation: 'unknown' }).success).toBe(true);
    expect(commandSchema.safeParse({ ...create, data: { ...applicationData, submissionStatus: 'confirmado' } }).success).toBe(false);
  });
  it('aceita CV novo e correção da oportunidade com versão própria', () => {
    expect(commandSchema.safeParse({ operation: 'create_resume_ref', clientId: id, data: { label: 'CV', stack: [], language: null, localRef: null } }).success).toBe(true);
    expect(commandSchema.safeParse({ operation: 'update_application', application: ref, changes: {}, opportunityPatch: { opportunity: ref, changes: { company: 'Corrigida' } }, evidence: null }).success).toBe(true);
    expect(commandSchema.safeParse({ operation: 'update_application', application: ref, changes: { applicationInstance: 'second' } }).success).toBe(false);
  });
  it('limita texto, links e bytes UTF-8 do comando', () => {
    expect(commandSchema.safeParse({ ...create, data: { ...applicationData, notes: 'x'.repeat(50_001) } }).success).toBe(false);
    const link = { originalUrl: 'https://example.invalid', comparisonUrl: null, kind: 'vaga', isLocal: false, isPrivate: true };
    expect(commandSchema.safeParse({ ...create, data: { ...applicationData, links: Array.from({ length: 51 }, () => link) } }).success).toBe(false);
    const large = { ...create, data: { ...applicationData, notes: '界'.repeat(50_000), opportunity: { ...opportunity, description: '界'.repeat(50_000) } } };
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(MAX_COMMAND_BYTES);
    expect(commandSchema.safeParse(large).success).toBe(false);
    expect(commandSchema.safeParse({ ...create, data: { ...applicationData, applicationInstance: ' '.repeat(MAX_COMMAND_BYTES) + 'initial' } }).success).toBe(false);
  });
  const mutations = [
    { operation: 'update_application', application: ref, changes: { notes: null } },
    { operation: 'record_event', clientId: id, application: ref, data: event },
    { operation: 'correct_event', clientId: id, application: ref, eventId: id, replacement: event, reason: 'Corrigir data', evidence },
    { operation: 'save_task', target: { clientId: id }, parents, data: { title: 'Preparar entrevista', dueDate: unknownDate } },
    { operation: 'complete_task', task: ref, parents, completedDate: day('2026-11-10') },
    { operation: 'save_contact', target: ref, data: { name: null, notes: null, links: [] } },
    { operation: 'archive_application', application: ref },
    { operation: 'restore_application', application: ref },
    { operation: 'resolve_duplicate', application: ref, canonicalApplication: { ...ref, id: '00000000-0000-4000-8000-000000000102' }, reason: 'Mesma ocorrência', evidence },
    { operation: 'invalidate_submission', application: ref, reason: 'Sem confirmação', evidence },
    { operation: 'close_review', batch: ref, narrative: null, decisions: [] },
    { operation: 'revise_review', batch: ref, predecessorId: id, type: 'rectification', narrative: null, decisions: [], reason: 'Corrigir população', evidence },
    { operation: 'update_settings', settings: ref, dailyGoal: 5, timezone: 'America/Sao_Paulo' },
    { operation: 'revoke_agent_credential', credential: ref },
  ];
  it.each(mutations)('aceita contrato definido para $operation', (command) => { expect(commandSchema.safeParse(command).success).toBe(true); });
  it.each(mutations)('recusa edição sem expectedVersion em $operation', (command) => {
    const missing = JSON.parse(JSON.stringify(command).replaceAll('"expectedVersion":1', '"missingVersion":1'));
    expect(commandSchema.safeParse(missing).success).toBe(false);
  });
  it('exige versões para os dois pais de uma tarefa', () => {
    const command = { operation: 'save_task', target: { clientId: id }, parents: { application: ref, contact: { id } }, data: { title: 'Retornar', dueDate: unknownDate } };
    expect(commandSchema.safeParse(command).success).toBe(false);
    expect(commandSchema.safeParse({ ...command, parents: { application: ref, contact: ref } }).success).toBe(true);
  });
  it('credencial recebe somente hash e escopos permitidos', () => {
    const credential = { operation: 'create_agent_credential', clientId: id, label: 'Agente de teste', prefix: 'ct_test', tokenHash: 'a'.repeat(64), scopes: ['career:read'], expiresAt: null };
    expect(commandSchema.safeParse(credential).success).toBe(true);
    expect(commandSchema.safeParse({ ...credential, token: 'segredo' }).success).toBe(false);
    expect(commandSchema.safeParse({ ...credential, scopes: ['career:admin'] }).success).toBe(false);
  });
  it('consultas limitam filtros, paginação e período, preservando pesquisa literal', () => {
    const query = { operation: 'list_applications', view: 'confirmed', search: '100% _ teste', filters: {}, page: { limit: 30, after: null } };
    expect(querySchema.parse(query)).toEqual(query);
    expect(querySchema.safeParse({ ...query, sql: 'SELECT 1' }).success).toBe(false);
    expect(querySchema.safeParse({ ...query, page: { limit: 101, after: null } }).success).toBe(false);
    expect(querySchema.safeParse({ operation: 'metrics', period: { from: '2026-11-10', to: '2026-11-01' }, population: 'confirmed', dimension: 'stack' }).success).toBe(false);
  });
  it('transferência exige versão, entidades tipadas e exclui credenciais/controle', () => {
    const manifest = { formatVersion: 1, exportedAt: '2026-11-15T12:00:00Z', sourceOwnerId: id, tables: [{ table: 'applications', count: 1, sha256: 'a'.repeat(64) }] };
    expect(transferManifestSchema.safeParse(manifest).success).toBe(true);
    expect(transferManifestSchema.safeParse({ ...manifest, formatVersion: 2 }).success).toBe(false);
    expect(transferManifestSchema.safeParse({ ...manifest, tables: [{ table: 'agent_credentials', count: 1, sha256: 'a'.repeat(64) }] }).success).toBe(false);
    expect(transferEntitySchema.safeParse({ formatVersion: 1, table: 'applications', data: {} }).success).toBe(false);
    expect(transferEntitySchema.safeParse({ formatVersion: 1, table: 'owner_settings', data: { id, version: 1, createdAt: '2026-11-15T12:00:00Z', updatedAt: '2026-11-15T12:00:00Z', dailyGoal: 5, timezone: 'America/Sao_Paulo' } }).success).toBe(true);
  });
  it('limita também textos históricos de auditoria transferidos', () => {
    const audit = { formatVersion: 1, table: 'audit_log', data: { id, actor: { kind: 'owner', id }, source: 'teste', occurredAt: '2026-11-15T12:00:00Z', entityType: 'application', entityId: id, operation: 'save_application', beforeData: null, afterData: { notes: 'a'.repeat(50_001) }, diff: {}, requestId: id, createdAt: '2026-11-15T12:00:00Z' } };
    expect(transferEntitySchema.safeParse(audit).success).toBe(false);
  });
  it('transfere deduplicação durável sem credenciais nem respostas HTTP', () => {
    const row = { formatVersion: 1, table: 'creation_requests', data: { id, createdAt: '2026-11-15T12:00:00Z', clientId: id, payloadHash: 'a'.repeat(64), entityType: 'application', resultApplicationId: id, resultContactId: null, resultTaskId: null, resultEventId: null } };
    expect(transferEntitySchema.safeParse(row).success).toBe(true);
    expect(transferEntitySchema.safeParse({ ...row, data: { ...row.data, entityType: 'agent_credential', resultCredentialId: id } }).success).toBe(false);
    expect(transferEntitySchema.safeParse({ ...row, table: 'mutation_keys' }).success).toBe(false);
  });
  it('preserva arquivo-fonte sintético maior que o limite de texto de comando', () => {
    const source = 'linha sintética\n'.repeat(6000);
    const row = { formatVersion: 1, table: 'source_files', data: { id, version: 1, createdAt: '2026-11-15T12:00:00Z', updatedAt: '2026-11-15T12:00:00Z', importRunId: id, fileName: 'fonte-sintetica.csv', fileHash: 'a'.repeat(64), originalBytesBase64: Buffer.from(source).toString('base64'), originalText: source } };
    expect(source.length).toBeGreaterThan(50_000);
    const parsed = transferEntitySchema.parse(row);
    expect(parsed.table).toBe('source_files');
    if (parsed.table === 'source_files') expect(parsed.data.originalText).toBe(source);
  });
  it('valida arquivo binário sintético de 3 MiB sem esgotar a pilha', () => {
    const row = { formatVersion: 1, table: 'source_files', data: { id, version: 1, createdAt: '2026-11-15T12:00:00Z', updatedAt: '2026-11-15T12:00:00Z', importRunId: id, fileName: 'fonte-sintetica.bin', fileHash: 'a'.repeat(64), originalBytesBase64: 'A'.repeat(4 * 1024 * 1024), originalText: null } };
    expect(transferEntitySchema.safeParse(row).success).toBe(true);
  });
});
