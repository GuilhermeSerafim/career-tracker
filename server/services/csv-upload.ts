import { normalizeJobUrl } from '../../domain/identity.js';
import { compareLegacyRows, LEGACY_HEADER, parseLegacyCsv, projectableLegacyLinks, projectLegacySourceAttribution, sha256, type LegacyParse, type LegacyRow } from '../../domain/import.js';
import { MAX_CSV_UPLOAD_BYTES, MAX_CSV_UPLOAD_ROWS, type CsvPreview, type CsvUpload } from '../../shared/csv-upload.js';
import { shortTextSchema } from '../../shared/model.js';
import type { AuthenticatedTransaction } from '../database';
import { SafeError } from '../errors.js';
import { loadImportBasis } from '../repositories/transfers.js';

type PreviewRow = CsvPreview['rows'][number];

export function readCsvUpload(upload: CsvUpload) {
  const bytes = Buffer.from(upload.bytesBase64, 'base64');
  if (bytes.length > MAX_CSV_UPLOAD_BYTES) throw new SafeError('PAYLOAD_TOO_LARGE');
  if (bytes.toString('base64') !== upload.bytesBase64) throw new SafeError('INVALID_INPUT');
  if (bytes.includes(0)) {
    return { bytes, parsed: { sourceHash: sha256(bytes), blocked: true, rows: [], issues: [{ code: 'invalid_text', severity: 'error', row: null, column: null }] } satisfies LegacyParse };
  }
  return { bytes, parsed: parseLegacyCsv(bytes, MAX_CSV_UPLOAD_ROWS) };
}

const normalized = (value: string) => value.trim().toLowerCase();

function jobUrlKey(original: string): string | null {
  try { return normalizeJobUrl(original.trim()); }
  catch { return null; }
}

async function matchedJobUrlKeys(tx: AuthenticatedTransaction, owner: string, proposed: Set<string>) {
  const matches = new Set<string>();
  if (!proposed.size) return matches;
  // Os registros legados podem ter somente a URL original. A mesma função de
  // comparação atende os dois formatos sem regravar o histórico.
  const { rows } = await tx.query<{ original_url: string; comparison_url: string | null }>(`
    SELECT DISTINCT original_url,comparison_url FROM career.links
    WHERE owner_id=$1 AND NOT is_local AND (comparison_url IS NULL OR comparison_url=ANY($2::text[]))
  `, [owner, [...proposed]]);
  for (const { original_url, comparison_url } of rows) {
    const key = comparison_url ?? jobUrlKey(original_url);
    if (key && proposed.has(key)) matches.add(key);
  }
  return matches;
}

function identityHints(row: LegacyRow) {
  const company = normalized(row.company);
  const title = normalized(row.title);
  const platform = normalized(row.legacyPlatform);
  const code = row.jobCode.trim();
  const jobKey = row.jobKey.trim();
  const references = new Map(row.links.filter((link) => link.classification === 'web' || link.classification === 'private')
    .map((link) => [link.originalText, link.classification]));
  const urls: string[] = [];
  let requiresUrlReview = false;
  for (const [original, classification] of references) {
    const key = jobUrlKey(original);
    if (key) urls.push(key);
    else if (classification === 'web') requiresUrlReview = true;
  }
  const hints: string[] = [];
  if (company && title) hints.push(JSON.stringify(['company', company, title]));
  if (platform && code) hints.push(JSON.stringify(['code', platform, code]));
  if (platform && jobKey) hints.push(JSON.stringify(['key', platform, jobKey]));
  for (const url of urls) hints.push(JSON.stringify(['url', url]));
  return { company, title, platform, code, jobKey, urls, requiresUrlReview, hints: [...new Set(hints)] };
}

function issuesByRow(parsed: LegacyParse) {
  const grouped = new Map<number, Set<string>>();
  for (const { row, code } of parsed.issues) {
    if (row === null) continue;
    const codes = grouped.get(row) ?? new Set<string>();
    codes.add(code);
    grouped.set(row, codes);
  }
  return grouped;
}

async function existingMatches(tx: AuthenticatedTransaction, owner: string, candidates: { legacy_id: string; cycle_order: number | null; company: string; title: string; platform: string; code: string; job_key: string }[]) {
  const result = await tx.query<{ legacy_id: string; same_id: boolean; same_order: boolean; possible_duplicate: boolean }>(`
    WITH source AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS s(legacy_id text, cycle_order bigint, company text, title text, platform text, code text, job_key text)
    )
    SELECT s.legacy_id,
      EXISTS(SELECT 1 FROM career.applications a WHERE a.owner_id=$1 AND a.legacy_id=s.legacy_id) AS same_id,
      EXISTS(SELECT 1 FROM career.applications a WHERE a.owner_id=$1 AND a.cycle_order=s.cycle_order) AS same_order,
      (EXISTS(SELECT 1 FROM career.opportunities o WHERE o.owner_id=$1 AND (
        (s.company<>'' AND s.title<>'' AND lower(btrim(o.company))=s.company AND lower(btrim(o.title))=s.title)
        OR (s.platform<>'' AND s.platform=lower(btrim(o.platform)) AND (
          (s.code<>'' AND s.code=btrim(o.job_code)) OR (s.job_key<>'' AND s.job_key=btrim(o.job_key))))
      )) OR EXISTS(SELECT 1 FROM career.opportunity_identities i WHERE i.owner_id=$1 AND
        s.platform<>'' AND s.code<>'' AND i.normalized_provider=s.platform AND i.identity_kind='job_code' AND i.normalized_value=s.code
      )
      ) AS possible_duplicate
    FROM source s`, [owner, JSON.stringify(candidates)]);
  return new Map(result.rows.map((row) => [row.legacy_id, row]));
}

export async function planCsvUpload(tx: AuthenticatedTransaction, owner: string, fileName: string, parsed: LegacyParse): Promise<CsvPreview> {
  const issues = issuesByRow(parsed);
  const errors = parsed.issues.filter((issue) => issue.severity === 'error').map(({ code, row, column }) => ({ code, row, column }));
  if (!parsed.rows.length && !errors.length) errors.push({ code: 'empty_csv', row: null, column: null });
  const blocked = errors.length > 0;
  const identities = parsed.rows.map(identityHints);
  const hintsByRow = new Map<string, number>();
  for (const { hints } of identities) for (const hint of hints) hintsByRow.set(hint, (hintsByRow.get(hint) ?? 0) + 1);
  const ids = parsed.rows.map((row) => row.legacyId);
  const matches = blocked ? undefined : await existingMatches(tx, owner, parsed.rows.map((row, index) => {
    const { company, title, platform, code, jobKey } = identities[index]!;
    return { legacy_id: row.legacyId, cycle_order: row.cycleOrder, company, title, platform, code, job_key: jobKey };
  }));
  const matchedUrls = blocked ? undefined : await matchedJobUrlKeys(tx, owner, new Set(identities.flatMap(({ urls }) => urls)));
  const diff = blocked ? [] : compareLegacyRows(parsed.rows, await loadImportBasis(tx, owner, ids));
  const rows = parsed.rows.map((row, index): PreviewRow => {
    const number = index + 2;
    const rowIssues = issues.get(number) ?? new Set<string>();
    const match = matches?.get(row.legacyId);
    const identity = identities[index]!;
    const comparison = diff[index]?.kind;
    const { links, hasUnprojected } = projectableLegacyLinks(row.links);
    const { warning } = projectLegacySourceAttribution(row.source);
    if (hasUnprojected) rowIssues.add('unprojected_reference');
    if (warning) rowIssues.add(warning);
    // Uma URL web fora do comparador pode existir apenas no texto de origem.
    if (identity.requiresUrlReview) rowIssues.add('legacy_url_review');
    let status: PreviewRow['status'] = 'eligible';
    if (blocked) status = 'blocked';
    else if (comparison === 'unchanged') status = 'unchanged';
    else if (comparison !== 'new' || match?.same_id) {
      status = 'conflict';
      rowIssues.add(comparison && comparison !== 'new' ? comparison : 'existing_id');
    } else if (match?.same_order) {
      status = 'conflict';
      rowIssues.add('existing_order');
    } else if (match?.possible_duplicate || identity.urls.some((url) => matchedUrls?.has(url)) || identity.hints.some((hint) => hintsByRow.get(hint)! > 1) || rowIssues.has('possible_duplicate')) {
      status = 'duplicate';
      rowIssues.add('possible_duplicate');
    } else if (identity.requiresUrlReview) {
      status = 'blocked';
    } else if (
      row.legacyId.length > 200 || ![row.company, row.title, row.legacyPlatform, row.jobCode, row.jobKey].every((value) => shortTextSchema.safeParse(value).success)
      || links.length > 50
    ) {
      status = 'blocked';
      rowIssues.add('projection_limits');
    }
    return {
      number, legacyId: row.legacyId.slice(0, 200), company: row.company.slice(0, 500), title: row.title.slice(0, 500),
      submittedDate: row.submittedDate, submissionStatus: row.submissionStatus, cycleOrder: row.cycleOrder,
      missing: LEGACY_HEADER.filter((column) => !row.fields[column].trim()), issues: [...rowIssues], status,
    };
  });
  const eligible = rows.filter((row) => row.status === 'eligible').length;
  const unchanged = rows.filter((row) => row.status === 'unchanged').length;
  const totals = { rows: rows.length, eligible, unchanged, review: rows.length - eligible - unchanged };
  // A confirmação vincula os bytes, o nome e a seleção exibida. Recalculada sob
  // o lock de identidade, antes de arquivar o arquivo ou inserir candidaturas.
  const confirmation = eligible ? sha256(JSON.stringify([owner, fileName, parsed.sourceHash, rows.map(({ status, issues }) => [status, issues])])) : null;
  return { writes: false, blocked, confirmation, totals, issues: errors, rows };
}
