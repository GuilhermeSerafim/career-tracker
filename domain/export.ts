import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LEGACY_HEADER, parseLegacyCsv } from './import.js';
import { toLocalDay } from './dates.js';
import { MAX_DISPLAY_NUMBER, transferDataKeys, transferEntitySchema, transferManifestSchema, transferTableSchema, type TransferContinuity, type TransferEntity, type TransferManifest } from '../shared/transfer.js';
export const TRANSFER_TABLES = transferTableSchema.options;
export type TransferTable = typeof TRANSFER_TABLES[number];
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_SNAPSHOT_ROWS = 100000;
export class TransferError extends Error {
    constructor() { super('Transferência inválida, incompleta, ocupada ou acima dos limites; nenhuma informação privada foi exibida.'); }
}
export function safeCsvCell(value: string): string {
    const protectedValue = /^\s*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value) ? "'" + value : value;
    return '"' + protectedValue.replaceAll('"', '""') + '"';
}
/** Ordena só objetos; nunca usa atribuição por chave que invoque setters de protótipo. */
export function canonicalJson(input: unknown): string {
    const ancestors = new Set<object>();
    const visit = (value: unknown, depth: number): string => {
        if (depth > 64)
            throw new TransferError();
        if (value === null || typeof value === 'boolean' || typeof value === 'string')
            return JSON.stringify(value);
        if (typeof value === 'number') {
            if (!Number.isFinite(value))
                throw new TransferError();
            return JSON.stringify(value);
        }
        if (!value || typeof value !== 'object' || ancestors.has(value))
            throw new TransferError();
        if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
            throw new TransferError();
        ancestors.add(value);
        const result = Array.isArray(value) ? '[' + value.map((item) => visit(item, depth + 1)).join(',') + ']' : '{' + Reflect.ownKeys(value).map((key) => {
            if (typeof key !== 'string')
                throw new TransferError();
            const property = Object.getOwnPropertyDescriptor(value, key);
            if (!property?.enumerable || !Object.hasOwn(property, 'value'))
                throw new TransferError();
            return key;
        }).sort().map((key) => JSON.stringify(key) + ':' + visit(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1)).join(',') + '}';
        ancestors.delete(value);
        return result;
    };
    return visit(input, 0);
}
export const transferHash = (input: unknown) => createHash('sha256').update(canonicalJson(input)).digest('hex');
export interface Snapshot {
    manifest: TransferManifest;
    entities: TransferEntity[];
}
// O JSON de auditoria também pode conter texto antigo fora do domínio dos identificadores N.
function displayNumber(value: unknown): bigint | null {
    if (typeof value !== 'string' || !/^N[0-9]{6,}$/.test(value)) return null;
    const digits = value.slice(1).replace(/^0+/, '') || '0';
    if (digits.length > 19) return null;
    const number = BigInt(digits);
    return number <= MAX_DISPLAY_NUMBER ? number : null;
}
export const hasDisplayCapacity = (floor: bigint) => floor < MAX_DISPLAY_NUMBER;
export function restoreDisplayFloor(snapshot: Snapshot, destinationFloor = 0n): bigint {
    const sourceFloor = BigInt(snapshot.manifest.continuity?.displayHighWater ?? '0');
    let floor = sourceFloor > destinationFloor ? sourceFloor : destinationFloor;
    const include = (value: unknown) => {
        const number = displayNumber(value);
        if (number !== null && number > floor) floor = number;
    };
    for (const row of snapshot.entities) {
        if (row.table === 'applications') include(row.data.displayId);
        if (row.table === 'audit_log' && row.data.entityType === 'applications') {
            for (const data of [row.data.beforeData,row.data.afterData])
                if (data && typeof data === 'object' && Object.hasOwn(data,'display_id'))
                    include((data as Record<string,unknown>).display_id);
        }
    }
    return floor;
}
const snapshotSchema = z.strictObject({ manifest: transferManifestSchema, entities: z.array(transferEntitySchema).max(MAX_SNAPSHOT_ROWS) });
const order = (a: TransferEntity, b: TransferEntity) => a.table < b.table ? -1 : a.table > b.table ? 1 : a.data.id < b.data.id ? -1 : a.data.id > b.data.id ? 1 : 0;
/** Relações de negócio explícitas; entityId de auditoria pode apontar para histórico removido. */
export const TRANSFER_REFERENCES: Partial<Record<TransferTable, Record<string, TransferTable>>> = {
    applications: { opportunityId: 'opportunities', canonicalApplicationId: 'applications' },
    links: { opportunityId: 'opportunities', applicationId: 'applications', contactId: 'contacts' },
    application_resumes: { applicationId: 'applications', resumeId: 'resume_refs' },
    events: { applicationId: 'applications', evidenceId: 'evidence', supersedesEventId: 'events' },
    tasks: { applicationId: 'applications', contactId: 'contacts' }, batches: { cycleId: 'cycles' },
    batch_members: { batchId: 'batches', applicationId: 'applications' },
    review_versions: { batchId: 'batches', predecessorId: 'review_versions', evidenceId: 'evidence' },
    source_files: { importRunId: 'import_runs' }, import_rows: { sourceFileId: 'source_files', targetApplicationId: 'applications' },
    opportunity_identities: { opportunityId: 'opportunities', verificationEvidenceId: 'evidence' },
    creation_requests: { resultApplicationId: 'applications', resultContactId: 'contacts', resultTaskId: 'tasks', resultEventId: 'events', resultResumeId: 'resume_refs', resultEvidenceId: 'evidence', resultCycleId: 'cycles' },
};
export function validateReferences(entities: TransferEntity[], capturedFloor?: string): void {
    const index = new Map(entities.map((row) => [row.table + '/' + row.data.id, row]));
    if (index.size !== entities.length)
        throw new TransferError();
    let current = 0;
    const sourceBytes = new Map<string, Buffer>();
    const csvRows = new Map<string, ReturnType<typeof parseLegacyCsv>>();
    const bytesFor = (row: Extract<TransferEntity, {
        table: 'source_files';
    }>) => {
        let bytes = sourceBytes.get(row.data.id);
        if (!bytes) {
            bytes = Buffer.from(row.data.originalBytesBase64, 'base64');
            if (bytes.toString('base64') !== row.data.originalBytesBase64 || createHash('sha256').update(bytes).digest('hex') !== row.data.fileHash || row.data.originalText !== null && bytes.toString('utf8') !== row.data.originalText)
                throw new TransferError();
            sourceBytes.set(row.data.id, bytes);
        }
        return bytes;
    };
    for (const row of entities) {
        const data = row.data as unknown as Record<string, unknown>;
        for (const [field, table] of Object.entries(TRANSFER_REFERENCES[row.table] ?? {})) {
            if (data[field] != null && !index.has(table + '/' + data[field]))
                throw new TransferError();
        }
        if (row.table === 'applications' && row.data.displayId.startsWith('N')) {
            const number = displayNumber(row.data.displayId);
            // Uma origem que consumiu o último número continua exportável para consulta e prévia.
            if (number === null || !hasDisplayCapacity(number) && capturedFloor !== MAX_DISPLAY_NUMBER.toString())
                throw new TransferError();
        }
        if (row.table === 'cycles') {
            if (row.data.isCurrent === undefined || !Number.isSafeInteger(row.data.nextOrder))
                throw new TransferError();
            if (row.data.isCurrent)
                current++;
        }
        if (row.table === 'import_rows' && row.data.appliedTargetVersion != null) {
            const app = index.get('applications/' + row.data.targetApplicationId);
            if (app?.table !== 'applications' || row.data.appliedTargetVersion > app.data.version)
                throw new TransferError();
            const unit = row.data.unitResult as Record<string, unknown> | null;
            if (!unit || unit.applicationId !== app.data.id || unit.result !== row.data.result || !Number.isInteger(unit.version) || Number(unit.version) < row.data.appliedTargetVersion || Number(unit.version) > app.data.version)
                throw new TransferError();
        }
        if (row.table === 'source_files') {
            bytesFor(row);
        }
        if (row.table === 'import_rows') {
            const source = index.get('source_files/' + row.data.sourceFileId);
            if (source?.table !== 'source_files' || !/\.csv$/i.test(source.data.fileName))
                throw new TransferError();
            let parsed = csvRows.get(source.data.id);
            if (!parsed) {
                parsed = parseLegacyCsv(bytesFor(source));
                csvRows.set(source.data.id, parsed);
            }
            if (createHash('sha256').update(row.data.originalText).digest('hex') !== row.data.rowHash || parsed.rows[row.data.rowNumber - 2]?.raw !== row.data.originalText)
                throw new TransferError();
        }
        if (row.table === 'import_runs' && row.data.unitState && typeof row.data.unitState === 'object' && !Array.isArray(row.data.unitState)) {
            const unit = row.data.unitState;
            if (unit.cycleId != null && !index.has('cycles/' + unit.cycleId))
                throw new TransferError();
            if (unit.completed && typeof unit.completed === 'object' && !Array.isArray(unit.completed) && unit.completed.runId !== row.data.id)
                throw new TransferError();
            if (unit.review && typeof unit.review === 'object' && !Array.isArray(unit.review)) {
                const result = unit.review.result;
                if (result && typeof result === 'object' && !Array.isArray(result) && (!index.has('review_versions/' + result.reviewId) || !index.has('batches/' + result.batchId)))
                    throw new TransferError();
            }
        }
        if (row.table === 'events' && row.data.supersedesEventId) {
            const parent = index.get('events/' + row.data.supersedesEventId);
            if (parent?.table !== 'events' || parent.data.applicationId !== row.data.applicationId)
                throw new TransferError();
        }
        if (row.table === 'review_versions') {
            for (const id of [...row.data.populationIds, ...row.data.snapshot.populationIds])
                if (!index.has('applications/' + id))
                    throw new TransferError();
            for (const id of [...row.data.eventIds, ...row.data.snapshot.eventIds])
                if (!index.has('events/' + id))
                    throw new TransferError();
            if (row.data.predecessorId) {
                const prior = index.get('review_versions/' + row.data.predecessorId);
                if (prior?.table !== 'review_versions' || prior.data.batchId !== row.data.batchId)
                    throw new TransferError();
            }
        }
    }
    if (current > 1)
        throw new TransferError();
}
export function buildSnapshot(sourceOwnerId: string, entities: TransferEntity[], exportedAt = new Date().toISOString(), continuity?: TransferContinuity): Snapshot {
    const rows = [...entities].sort(order);
    const continuityField = continuity ? { continuity: { ...continuity, sha256: transferHash(continuity) } } : {};
    return validateSnapshot({ manifest: { formatVersion: 1, sourceOwnerId, exportedAt, ...continuityField, tables: TRANSFER_TABLES.map((table) => {
                const selected = rows.filter((row) => row.table === table);
                return { table, count: selected.length, sha256: transferHash(selected) };
            }) }, entities: rows });
}
export function validateSnapshot(input: unknown): Snapshot {
    try {
        const original = canonicalJson(input);
        if (Buffer.byteLength(original) > MAX_SNAPSHOT_BYTES)
            throw new TransferError();
        const parsed = snapshotSchema.parse(input);
        // Envelopes de controle nunca podem perder campos ou normalizar histórico.
        if (canonicalJson(parsed) !== original || parsed.manifest.tables.length !== TRANSFER_TABLES.length)
            throw new TransferError();
        const rows = [...parsed.entities].sort(order);
        for (const row of rows)
            if (transferDataKeys(row.table).some((key) => !Object.hasOwn(row.data, key)))
                throw new TransferError();
        for (const table of parsed.manifest.tables) {
            const selected = rows.filter((row) => row.table === table.table);
            if (table.count !== selected.length || table.sha256 !== transferHash(selected))
                throw new TransferError();
        }
        if (parsed.manifest.continuity) {
            const { sha256, ...continuity } = parsed.manifest.continuity;
            if (transferHash(continuity) !== sha256) throw new TransferError();
            const retired = new Set(continuity.retiredClients);
            if (rows.some(row => row.table === 'creation_requests' &&
                retired.has(createHash('sha256').update(row.data.clientId.toLowerCase()).digest('hex')))) throw new TransferError();
        }
        validateReferences(rows, parsed.manifest.continuity?.displayHighWater);
        restorationOrder(rows);
        return { manifest: parsed.manifest, entities: rows };
    }
    catch {
        throw new TransferError();
    }
}
/** Ordem de dependências com detecção linear de ciclos, inclusive autorreferências. */
export function restorationOrder(entities: TransferEntity[]): TransferEntity[] {
    const index = new Map(entities.map((row) => [row.table + '/' + row.data.id, row]));
    const state = new Map<string, number>();
    const result: TransferEntity[] = [];
    const visit = (root: TransferEntity) => {
        const stack: {
            row: TransferEntity;
            exit: boolean;
        }[] = [{ row: root, exit: false }];
        while (stack.length) {
            const { row, exit } = stack.pop()!;
            const key = row.table + '/' + row.data.id;
            if (exit) {
                state.set(key, 2);
                result.push(row);
                continue;
            }
            if (state.get(key) === 2)
                continue;
            if (state.get(key) === 1)
                throw new TransferError();
            state.set(key, 1);
            stack.push({ row, exit: true });
            for (const [field, table] of Object.entries(TRANSFER_REFERENCES[row.table] ?? {})) {
                const id = (row.data as unknown as Record<string, unknown>)[field];
                if (id != null) {
                    const parent = index.get(table + '/' + id);
                    if (!parent)
                        throw new TransferError();
                    stack.push({ row: parent, exit: false });
                }
            }
        }
    };
    for (const row of entities)
        visit(row);
    return result;
}
export function snapshotCsv(input: Snapshot): string {
    const snapshot = validateSnapshot(input);
    const index = new Map(snapshot.entities.map((row) => [row.table + '/' + row.data.id, row]));
    const applied = new Map<string, Extract<TransferEntity, {
        table: 'import_rows';
    }>>();
    const linksByTarget = new Map<string, Map<string, string>>();
    const resumesByApplication = new Map<string, { id: string; label: string | null }[]>();
    for (const row of snapshot.entities) {
        if (row.table === 'links') {
            for (const key of [row.data.applicationId ? 'applications/' + row.data.applicationId : null, row.data.opportunityId ? 'opportunities/' + row.data.opportunityId : null]) {
                if (!key) continue;
                const links = linksByTarget.get(key) ?? new Map<string, string>();
                links.set(row.data.id, row.data.originalUrl);
                linksByTarget.set(key, links);
            }
        }
        if (row.table === 'application_resumes' && row.data.isActive) {
            const resume = index.get('resume_refs/' + row.data.resumeId);
            if (resume?.table !== 'resume_refs') throw new TransferError();
            const refs = resumesByApplication.get(row.data.applicationId) ?? [];
            refs.push({ id: resume.data.id, label: resume.data.label });
            resumesByApplication.set(row.data.applicationId, refs);
        }
    }
    for (const row of snapshot.entities)
        if (row.table === 'import_rows' && row.data.result === 'imported' && row.data.targetApplicationId && row.data.appliedTargetVersion != null) {
            const prior = applied.get(row.data.targetApplicationId);
            if (!prior || (prior.data.appliedTargetVersion ?? 0) < row.data.appliedTargetVersion)
                applied.set(row.data.targetApplicationId, row);
        }
    const day = (date: Parameters<typeof toLocalDay>[0]) => toLocalDay(date) ?? '';
    const lines = [LEGACY_HEADER.map(safeCsvCell).join(',')];
    for (const row of snapshot.entities)
        if (row.table === 'applications') {
            const app = row.data;
            const opportunity = index.get('opportunities/' + app.opportunityId);
            if (opportunity?.table !== 'opportunities')
                throw new TransferError();
            const op = opportunity.data;
            const prior = applied.get(app.id);
            const raw = prior ? parseLegacyCsv(LEGACY_HEADER.join(',') + '\n' + prior.data.originalText).rows[0]?.fields : undefined;
            const links = new Map([...(linksByTarget.get('applications/' + app.id) ?? []), ...(linksByTarget.get('opportunities/' + op.id) ?? [])]);
            const urls = [...links.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, url]) => url);
            const activeResumes = resumesByApplication.get(app.id) ?? [];
            activeResumes.sort((a, b) => (a.label ?? '') < (b.label ?? '') ? -1 : (a.label ?? '') > (b.label ?? '') ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            const sentCv = activeResumes.length ? activeResumes.flatMap((ref) => ref.label === null ? [] : [ref.label]).join(' | ') : app.legacyResumeText ?? raw?.cv_enviado ?? '';
            const values = { id: app.displayId, empresa: op.company ?? '', cargo: op.title ?? '', plataforma: raw?.plataforma ?? '', codigo_vaga: op.jobCode ?? '', chave_vaga: op.jobKey ?? '', url_original: raw?.url_original ?? urls[0] ?? '', links_alternativos: raw?.links_alternativos ?? urls.slice(1).join(' | '), status_envio: app.submissionStatus, data_envio: day(app.submittedDate), evidencia_envio: raw?.evidencia_envio ?? '', cv_enviado: sentCv, etapa: app.stage !== 'desconhecida' ? app.stage : raw?.etapa ?? '', ordem_ciclo: app.cycleOrder?.toString() ?? '', fonte: raw?.fonte ?? '', observacoes: app.notes ?? '', registrado_em: day(app.legacyRegisteredDate) };
            lines.push(LEGACY_HEADER.map((key) => safeCsvCell(values[key])).join(','));
        }
    return lines.join('\r\n') + '\r\n';
}
