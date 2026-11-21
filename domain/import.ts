import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { assignableCycleOrderSchema, dateValueSchema, isCalendarDay, linkDataSchema, positiveVersionSchema, sha256Schema, shortTextSchema, submissionStatusSchema, type DateValue } from '../shared/model.js';
import { MAX_SOURCE_ARCHIVE_BYTES } from '../shared/transfer.js';

export const IMPORTER_VERSION = 'legacy-preview/2' as const;
export const PARSER_VERSION = 'csv-parse/7.0.3' as const;
export const MAX_LEGACY_ROWS = 100_000;
export const MAX_LEGACY_RAW_RECORD_CHARS = 50_000;
export const LEGACY_HEADER = ['id', 'empresa', 'cargo', 'plataforma', 'codigo_vaga', 'chave_vaga', 'url_original', 'links_alternativos', 'status_envio', 'data_envio', 'evidencia_envio', 'cv_enviado', 'etapa', 'ordem_ciclo', 'fonte', 'observacoes', 'registrado_em'] as const;
export type LegacyColumn = typeof LEGACY_HEADER[number];
const fieldsSchema = z.strictObject(Object.fromEntries(LEGACY_HEADER.map((key) => [key, z.string()])) as Record<LegacyColumn, z.ZodString>);
const issueSchema = z.strictObject({ code: z.string(), severity: z.enum(['error', 'warning']), row: z.number().int().positive().nullable(), column: z.enum(LEGACY_HEADER).nullable() });
export type ImportIssue = z.infer<typeof issueSchema>;
const referenceSchema = z.strictObject({ originalText: z.string(), classification: z.enum(['web', 'local', 'private', 'dangerous', 'unknown']) });
export const legacyRowSchema = z.strictObject({
  legacyId: z.string(), fields: fieldsSchema, raw: z.string().max(MAX_LEGACY_RAW_RECORD_CHARS), rawRowHash: sha256Schema,
  byteStart: z.number().int().nonnegative(), byteEnd: z.number().int().positive(),
  company: z.string(), title: z.string(), jobCode: z.string(), jobKey: z.string(),
  legacyPlatform: z.string(), submissionStatus: submissionStatusSchema.nullable(), submittedDate: dateValueSchema,
  legacyRegisteredDate: dateValueSchema, stage: z.literal('desconhecida'), stageNarrative: z.string(),
  discoveryChannel: z.null(), submissionPlatform: z.null(), tenant: z.null(), cycleRelation: z.literal('unknown'),
  legacyResumeText: z.string(), cycleOrder: assignableCycleOrderSchema.nullable(), evidence: z.string(), source: z.string(),
  links: z.array(referenceSchema),
  provenance: z.record(z.enum(LEGACY_HEADER), z.strictObject({ column: z.enum(LEGACY_HEADER), rawRowHash: sha256Schema, originalText: z.string() })),
});
export type LegacyRow = z.infer<typeof legacyRowSchema>;
export const legacyParseSchema = z.strictObject({ sourceHash: sha256Schema, rows: z.array(legacyRowSchema).max(MAX_LEGACY_ROWS), issues: z.array(issueSchema), blocked: z.boolean() });
export type LegacyParse = z.infer<typeof legacyParseSchema>;
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const unknownDate = (): DateValue => ({ precision: 'unknown', value: null });
interface CsvRecord { record: string[]; info: { bytes: number } }
class LegacyInputError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Parser limitado reutilizável: não materializa projeções nem aceita truncamento. */
export function readLegacyCsvRecords(bytes: Uint8Array, maxRows = MAX_LEGACY_ROWS): CsvRecord[] {
  if (bytes.byteLength > MAX_SOURCE_ARCHIVE_BYTES) throw new LegacyInputError('source_too_large');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new LegacyInputError('invalid_utf8'); }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0;
  return parse(buffer, {
    bom: true, info: true, skip_empty_lines: false, relax_column_count: false, record_delimiter: ['\r\n', '\n', '\r'],
    // O buffer interno conta bytes do campo atual. A margem UTF-8 permite 50 mil
    // caracteres multibyte; o limite exato de texto bruto é conferido abaixo.
    max_record_size: MAX_LEGACY_RAW_RECORD_CHARS * 4,
    cast: (value, context) => {
      // Evita milhões de campos vazios contornando max_record_size.
      if (typeof context.column === 'number' && context.column >= LEGACY_HEADER.length) throw new LegacyInputError('invalid_csv');
      return value;
    },
    on_record: (record, context) => {
      if (context.records > maxRows + 1) throw new LegacyInputError('row_limit');
      if (buffer.subarray(start, context.bytes).toString('utf8').length > MAX_LEGACY_RAW_RECORD_CHARS) throw new LegacyInputError('record_too_large');
      start = context.bytes;
      return record;
    },
  }) as unknown as CsvRecord[];
}

/** Classifica somente; nunca abre nem normaliza a referência arquivada. */
export function classifyLegacyReference(originalText: string): z.infer<typeof referenceSchema> {
  const value = originalText.trim();
  let classification: z.infer<typeof referenceSchema>['classification'] = 'unknown';
  if (/^(?:[a-z]:[\\/]|\\\\|file:|\.{0,2}\/)/i.test(value)) classification = 'local';
  else if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      classification = url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(url.hostname) ? 'private' : 'web';
    } catch { classification = 'unknown'; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) classification = 'dangerous';
  return { originalText, classification };
}

/** O parser define fronteiras CSV; hashes usam fatias dos bytes originais, inclusive CRLF. */
export function parseLegacyCsv(input: string | Uint8Array, maxRows = MAX_LEGACY_ROWS): LegacyParse {
  const result: LegacyParse = { sourceHash: sha256(input), rows: [], issues: [], blocked: false };
  const issue = (code: string, severity: ImportIssue['severity'], row: number | null = null, column: LegacyColumn | null = null) => {
    result.issues.push({ code, severity, row, column });
    if (severity === 'error') result.blocked = true;
  };
  if ((typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength) > MAX_SOURCE_ARCHIVE_BYTES) { issue('source_too_large', 'error'); return result; }
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let records: CsvRecord[];
  try { records = readLegacyCsvRecords(bytes, maxRows); }
  catch (error) {
    issue(error instanceof LegacyInputError ? error.code : (error instanceof Error && 'code' in error && error.code === 'CSV_MAX_RECORD_SIZE' ? 'record_too_large' : 'invalid_csv'), 'error');
    return result;
  }
  if (JSON.stringify(records[0]?.record) !== JSON.stringify(LEGACY_HEADER)) {
    issue('invalid_header', 'error'); return result;
  }
  let start = records[0]!.info.bytes;
  const ids = new Set<string>();
  const orders = new Set<number>();
  const identities = new Set<string>();
  for (const [index, record] of records.slice(1).entries()) {
    const rowNumber = index + 2;
    const fields = Object.fromEntries(LEGACY_HEADER.map((column, position) => [column, record.record[position]!])) as Record<LegacyColumn, string>;
    const rawBytes = bytes.subarray(start, record.info.bytes);
    const rawRowHash = sha256(rawBytes);
    const date = (column: 'data_envio' | 'registrado_em'): DateValue => {
      if (fields[column] === '') return unknownDate();
      if (!isCalendarDay(fields[column])) { issue('invalid_date', 'error', rowNumber, column); return unknownDate(); }
      return { precision: 'day', certainty: 'exact', value: fields[column] };
    };
    const status = submissionStatusSchema.safeParse(fields.status_envio);
    if (!status.success) issue('invalid_status', 'error', rowNumber, 'status_envio');
    if (!/^V\d+$/.test(fields.id)) issue('invalid_id', 'error', rowNumber, 'id');
    if (ids.has(fields.id)) issue('duplicate_id', 'error', rowNumber, 'id');
    ids.add(fields.id);
    let cycleOrder: number | null = null;
    if (fields.ordem_ciclo !== '') {
      const number = Number(fields.ordem_ciclo);
      if (!/^[1-9]\d*$/.test(fields.ordem_ciclo) || !assignableCycleOrderSchema.safeParse(number).success) issue('invalid_order', 'error', rowNumber, 'ordem_ciclo');
      else {
        cycleOrder = number;
        if (orders.has(number)) issue('duplicate_order', 'error', rowNumber, 'ordem_ciclo');
        orders.add(number);
      }
    }
    const identity = JSON.stringify([fields.empresa, fields.cargo, fields.plataforma, fields.codigo_vaga, fields.chave_vaga]);
    if ([fields.empresa, fields.cargo, fields.codigo_vaga, fields.chave_vaga].some(Boolean)) {
      if (identities.has(identity)) issue('possible_duplicate', 'warning', rowNumber);
      identities.add(identity);
    }
    const links = [fields.url_original, ...(fields.links_alternativos === '' ? [] : fields.links_alternativos.split(' | '))].filter((text) => text !== '').map(classifyLegacyReference);
    for (const link of links) if (link.classification === 'dangerous' || link.classification === 'unknown') issue(link.classification === 'dangerous' ? 'dangerous_reference' : 'unknown_reference', 'warning', rowNumber);
    const submittedDate = date('data_envio');
    if (submittedDate.precision === 'unknown') issue('unknown_submission_date', 'warning', rowNumber, 'data_envio');
    issue('unresolved_tenant_channels_stage', 'warning', rowNumber);
    result.rows.push({
      legacyId: fields.id, fields, raw: rawBytes.toString('utf8'), rawRowHash, byteStart: start, byteEnd: record.info.bytes,
      company: fields.empresa, title: fields.cargo, jobCode: fields.codigo_vaga, jobKey: fields.chave_vaga,
      legacyPlatform: fields.plataforma, submissionStatus: status.success ? status.data : null,
      submittedDate, legacyRegisteredDate: date('registrado_em'), stage: 'desconhecida', stageNarrative: fields.etapa,
      discoveryChannel: null, submissionPlatform: null, tenant: null, cycleRelation: 'unknown',
      legacyResumeText: fields.cv_enviado, cycleOrder, evidence: fields.evidencia_envio, source: fields.fonte, links,
      provenance: Object.fromEntries(LEGACY_HEADER.map((column) => [column, { column, rawRowHash, originalText: fields[column] }])) as LegacyRow['provenance'],
    });
    start = record.info.bytes;
  }
  return legacyParseSchema.parse(result);
}

export function projectableLegacyLinks(references: LegacyRow['links']) {
  const distinct = new Map(references.map((link) => [link.originalText, link]));
  const links = [...distinct.values()].filter((link) => ['web', 'private', 'local'].includes(link.classification) && link.originalText.trim() !== ''
    && linkDataSchema.safeParse({
      originalUrl: link.originalText, comparisonUrl: null, kind: 'legado',
      isLocal: link.classification === 'local', isPrivate: link.classification !== 'web',
    }).success);
  return { links, hasUnprojected: links.length !== distinct.size };
}

export const UNPROJECTED_SOURCE_ATTRIBUTION = 'unprojected_source_attribution';

/** Projeção aplicada à evidência; a prévia e o texto bruto permanecem integrais. */
export function projectLegacySourceAttribution(source: string, decision?: 'source' | 'current') {
  if (decision === 'current') return { source: null, warning: null };
  const parsed = shortTextSchema.safeParse(source);
  return parsed.success ? { source: parsed.data || null, warning: null } : { source: null, warning: UNPROJECTED_SOURCE_ATTRIBUTION };
}

export const previousImportSchema = z.strictObject({ legacyId: z.string().max(500).regex(/^V\d+$/), rawRowHash: sha256Schema, importedApplicationVersion: positiveVersionSchema, currentApplicationVersion: positiveVersionSchema });
export const previousImportStatesSchema = z.array(previousImportSchema).max(MAX_LEGACY_ROWS)
  .refine((states) => new Set(states.map((state) => state.legacyId)).size === states.length, 'IDs repetidos impedem comparação.')
  .refine((states) => Buffer.byteLength(JSON.stringify(states)) <= MAX_SOURCE_ARCHIVE_BYTES, 'A base de comparação excede 50 MiB.');
export type PreviousImportState = z.infer<typeof previousImportSchema>;
export const legacyDiffSchema = z.array(z.strictObject({ legacyId: z.string(), kind: z.enum(['new', 'unchanged', 'source_changed', 'application_changed', 'conflict', 'source_missing']) })).max(MAX_LEGACY_ROWS * 2);
export type LegacyDiff = z.infer<typeof legacyDiffSchema>;
/** Versão diferente protege alterações no app; não há aplicação/escrita implícita. */
export function compareLegacyRows(rows: Pick<LegacyRow, 'legacyId' | 'rawRowHash'>[], previous: PreviousImportState[]): LegacyDiff {
  const basis = previousImportStatesSchema.parse(previous);
  if (new Set(rows.map((row) => row.legacyId)).size !== rows.length) throw new Error('IDs repetidos impedem comparação.');
  const states = new Map(basis.map((state) => [state.legacyId, state]));
  const diff: LegacyDiff = rows.map((row) => {
    const old = states.get(row.legacyId);
    if (!old) return { legacyId: row.legacyId, kind: 'new' };
    const sourceChanged = old.rawRowHash !== row.rawRowHash;
    const appChanged = old.importedApplicationVersion !== old.currentApplicationVersion;
    return { legacyId: row.legacyId, kind: sourceChanged ? (appChanged ? 'conflict' : 'source_changed') : (appChanged ? 'application_changed' : 'unchanged') };
  });
  const ids = new Set(rows.map((row) => row.legacyId));
  for (const old of basis) if (!ids.has(old.legacyId)) diff.push({ legacyId: old.legacyId, kind: 'source_missing' });
  return legacyDiffSchema.parse(diff);
}
