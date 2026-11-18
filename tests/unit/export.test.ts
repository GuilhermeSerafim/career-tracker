import { describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { buildSnapshot, safeCsvCell, snapshotCsv } from '../../domain/export';
import { LEGACY_HEADER, sha256 } from '../../domain/import';
import type { TransferEntity } from '../../shared/transfer';
const owner = '00000000-0000-4000-8000-000000000001';
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const instant = '2026-11-16T10:00:00.123456Z';
const base = (value: number) => ({ id: id(value), version: 1, createdAt: instant, updatedAt: instant });
const unknown = { precision: 'unknown' as const, value: null };
function csvFixture(legacy: boolean, known: boolean) {
    const entities: TransferEntity[] = [
        { formatVersion: 1, table: 'opportunities', data: { ...base(10), company: 'Empresa', title: 'Cargo', platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'desconhecido', seniority: null, modality: null, description: null, stack: [] } },
        { formatVersion: 1, table: 'applications', data: { ...base(11), opportunityId: id(10), legacyId: legacy ? 'V001' : null, displayId: legacy ? 'V001' : 'N000001', track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: unknown, stage: known ? 'entrevista' : 'desconhecida', discoveryChannel: null, submissionPlatform: null, notes: 'Nota atual', cycleRelation: 'unknown', cycleOrder: null, countingEligible: true, archivedAt: null, canonicalApplicationId: null, legacyRegisteredDate: unknown, legacyResumeText: legacy ? ' CV legado | literal ' : null } },
        ...[20, 21].flatMap((value): TransferEntity[] => [
            { formatVersion: 1, table: 'resume_refs', data: { ...base(value), label: value === 20 ? 'CV B' : 'CV A', stack: [], language: null, localRef: null } },
            { formatVersion: 1, table: 'application_resumes', data: { ...base(value + 10), applicationId: id(11), resumeId: id(value), isActive: known } },
        ]),
    ];
    if (legacy) {
        const cells = ['V001', 'Empresa antiga', 'Cargo antigo', 'plataforma literal', '', '', '', '', 'confirmado', '', 'Relato', ' CV legado | literal ', ' narrativa original ', '', ' fonte literal ', 'Nota fonte', ''];
        const raw = cells.map(value => '"' + value.replaceAll('"', '""') + '"').join(',') + '\r\n';
        const bytes = Buffer.from(LEGACY_HEADER.join(',') + '\r\n' + raw);
        entities.push(
            { formatVersion: 1, table: 'import_runs', data: { ...base(40), importerVersion: 'legacy-preview/2', sourceSetHash: sha256(bytes), status: 'completed', pendingIssues: [], unitState: {} } },
            { formatVersion: 1, table: 'source_files', data: { ...base(41), importRunId: id(40), fileName: 'fixture.csv', fileHash: sha256(bytes), originalBytesBase64: bytes.toString('base64'), originalText: bytes.toString('utf8') } },
            { formatVersion: 1, table: 'import_rows', data: { ...base(42), sourceFileId: id(41), rowNumber: 2, rowHash: sha256(raw), originalText: raw, legacyId: 'V001', targetApplicationId: id(11), result: 'imported', pendingIssues: [], appliedTargetVersion: 1, resolution: { appliedInterpretation: {} }, unitResult: { applicationId: id(11), version: 1, result: 'imported' } } },
        );
    }
    return buildSnapshot(owner, entities, instant);
}
describe('campos CSV atuais sem inventar narrativas', () => {
    it.each([false, true])('exporta somente estágio e CVs ativos explicitamente registrados em linha nova: %s', known => {
        expect(parse(snapshotCsv(csvFixture(false, known)), { columns: true })[0]).toMatchObject({ etapa: known ? 'entrevista' : '', cv_enviado: known ? 'CV A | CV B' : '', fonte: '', plataforma: '' });
    });
    it.each([false, true])('preserva narrativa legada até haver substituição atual registrada: %s', known => {
        expect(parse(snapshotCsv(csvFixture(true, known)), { columns: true })[0]).toMatchObject({ empresa: 'Empresa', cargo: 'Cargo', observacoes: 'Nota atual', etapa: known ? 'entrevista' : ' narrativa original ', cv_enviado: known ? 'CV A | CV B' : ' CV legado | literal ', fonte: ' fonte literal ', plataforma: 'plataforma literal' });
    });
});
describe('proteção CSV sem alterar limites das células', () => {
    it.each(['=', '+', '-', '@'].flatMap((marker) => ['', ' ', '\t', '\r', '\n', '\u00a0', '\ufeff'].map((prefix) => prefix + marker + 'SUM(1,2)')))('protege fórmula %j', (value) => {
        expect(parse(safeCsvCell(value))[0]).toEqual(["'" + value]);
    });
    it.each(['\ttext', '\rtext', '\ntext'])('protege controle inicial %j', (value) => {
        expect(parse(safeCsvCell(value))[0]).toEqual(["'" + value]);
    });
    it('preserva texto e fronteiras RFC4180', () => {
        const values = ['normal', 'text', 'record', ' ação, "texto"\nsegunda linha', 'texto\r\nseguinte'];
        expect(parse(values.map(safeCsvCell).join(','))[0]).toEqual(values);
    });
});
