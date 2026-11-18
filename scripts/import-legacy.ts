import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { compareLegacyRows, IMPORTER_VERSION, LEGACY_HEADER, legacyDiffSchema, legacyParseSchema, MAX_LEGACY_ROWS, PARSER_VERSION, parseLegacyCsv, previousImportStatesSchema, sha256, type LegacyParse, type PreviousImportState } from '../domain/import.js';
import { instantSchema, sha256Schema } from '../shared/model.js';
import { MAX_SOURCE_ARCHIVE_BYTES } from '../shared/transfer.js';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const selectedName = z.string().min(1).refine((name) => !/[\\/:]/.test(name) && !Array.from(name).some((char) => char.codePointAt(0)! < 32) && !name.startsWith('.') && !/[. ]$/.test(name) && /\.(csv|md|txt)$/i.test(name), 'Selecione somente nomes simples de controles CSV/Markdown/texto.');
const sourceSchema = z.strictObject({ name: selectedName, sourcePath: z.string(), snapshotPath: z.string(), sha256: sha256Schema, size: z.number().int().nonnegative().max(MAX_SOURCE_ARCHIVE_BYTES), ids: z.array(z.string()).max(MAX_LEGACY_ROWS), rowCount: z.number().int().nonnegative().max(MAX_LEGACY_ROWS), readAt: instantSchema });
const sourceSetHash = (sources: { name: string; sha256: string }[]) => sha256(JSON.stringify({ importer: IMPORTER_VERSION, parser: PARSER_VERSION, sources: [...sources].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(({ name, sha256 }) => ({ name, sha256 })) }));
export const comparisonSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('source_only'), basis: z.tuple([]) }),
  z.strictObject({ mode: z.literal('captured_prior_state'), basis: previousImportStatesSchema }),
]);
function expectedDiff(parsed: LegacyParse, comparison: z.infer<typeof comparisonSchema>) {
  return parsed.blocked ? [] : compareLegacyRows(parsed.rows, comparison.basis);
}
export const manifestSchema = z.strictObject({
  formatVersion: z.literal(2), mode: z.literal('preview'), importerVersion: z.literal(IMPORTER_VERSION), parserVersion: z.literal(PARSER_VERSION),
  sourceSetHash: sha256Schema, startedAt: instantSchema, completedAt: instantSchema, snapshotDirectory: z.string(),
  writerFreeze: z.literal(false), requiresSourceRecheckBeforeApply: z.literal(true),
  sources: z.array(sourceSchema).min(1), parsed: legacyParseSchema, comparison: comparisonSchema, diff: legacyDiffSchema,
}).superRefine((manifest, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Manifesto inconsistente.' });
  if (new Set(manifest.sources.map((s) => s.name)).size !== manifest.sources.length || manifest.sourceSetHash !== sourceSetHash(manifest.sources)) fail();
  const csv = manifest.sources.filter((s) => /\.csv$/i.test(s.name));
  if (csv.length !== 1 || csv[0]?.sha256 !== manifest.parsed.sourceHash || csv[0]?.rowCount !== manifest.parsed.rows.length || JSON.stringify(csv[0]?.ids) !== JSON.stringify(manifest.parsed.rows.map((r) => r.legacyId))) fail();
  if (manifest.sources.some((s) => s.snapshotPath !== `sources/${s.name}`)) fail();
  if (manifest.parsed.blocked !== manifest.parsed.issues.some((i) => i.severity === 'error')) fail();
  if (manifest.sources.reduce((sum, source) => sum + source.size, 0) > MAX_SOURCE_ARCHIVE_BYTES) fail();
  try { if (!isDeepStrictEqual(expectedDiff(manifest.parsed, manifest.comparison), manifest.diff)) fail(); }
  catch { fail(); }
  for (const [index, row] of manifest.parsed.rows.entries()) {
    if (sha256(row.raw) !== row.rawRowHash || row.byteEnd > (csv[0]?.size ?? 0) || row.byteEnd - row.byteStart !== Buffer.byteLength(row.raw) || (index > 0 && row.byteStart !== manifest.parsed.rows[index - 1]!.byteEnd)) fail();
    for (const column of LEGACY_HEADER) {
      const provenance = row.provenance[column];
      if (provenance.column !== column || provenance.rawRowHash !== row.rawRowHash || provenance.originalText !== row.fields[column]) fail();
    }
    // As cópias editáveis não são evidência umas das outras: reprojeta o CSV bruto.
    const reparsed = parseLegacyCsv(LEGACY_HEADER.join(',') + '\n' + row.raw);
    const expected = reparsed.rows[0];
    if (reparsed.rows.length !== 1 || !expected || !isDeepStrictEqual({ ...row, byteStart: 0, byteEnd: 0 }, { ...expected, byteStart: 0, byteEnd: 0 })) fail();
  }
});
export type PreviewManifest = z.infer<typeof manifestSchema>;
export interface PreviewOptions { sourceDir: string; privateDir: string; files: string[]; previous?: PreviousImportState[] }
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

async function readBoundedFile(sourceDir: string, name: string, maxBytes: number): Promise<Buffer> {
  const source = path.join(sourceDir, name);
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || !within(sourceDir, await realpath(source))) throw new Error('Controle selecionado inválido ou acima do limite.');
  const handle = await open(source, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.size > maxBytes) throw new Error('Controle alterado durante leitura.');
    // Alocação limitada pelo stat verificado, sem readFile que pode crescer sem teto.
    const bytes = Buffer.alloc(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const read = await handle.read(bytes, position, bytes.length - position, position);
      if (read.bytesRead === 0) throw new Error('Controle alterado durante leitura.');
      position += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, position)).bytesRead !== 0) throw new Error('Controle cresceu durante leitura.');
    const after = await lstat(source);
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || !within(sourceDir, await realpath(source))) throw new Error('Controle alterado durante leitura.');
    return bytes;
  } finally { await handle.close(); }
}
async function readSelected(sourceDir: string, name: string, maxBytes = MAX_SOURCE_ARCHIVE_BYTES): Promise<Buffer> {
  selectedName.parse(name);
  return readBoundedFile(sourceDir, name, maxBytes);
}

/** Revalidação de evidência; apenas leitura. Um preview não congela os escritores. */
export async function findOriginalSourceDrift(input: PreviewManifest): Promise<string[]> {
  const manifest = manifestSchema.parse(input);
  const changed: string[] = [];
  for (const source of manifest.sources) {
    try {
      if (path.basename(source.sourcePath) !== source.name || sha256(await readSelected(path.dirname(source.sourcePath), source.name, source.size)) !== source.sha256) changed.push(source.name);
    } catch { changed.push(source.name); }
  }
  return changed;
}

/** Verifica o artefato privado completo, independentemente do estado da origem. */
export async function verifyPreviewArtifact(input: PreviewManifest): Promise<void> {
  const manifest = manifestSchema.parse(input);
  const directory = await realpath(manifest.snapshotDirectory);
  const sourcesDirectory = path.join(directory, 'sources');
  if ((await lstat(sourcesDirectory)).isSymbolicLink() || await realpath(sourcesDirectory) !== sourcesDirectory) throw new Error('Diretório de cópias inválido.');
  for (const source of manifest.sources) {
    const bytes = await readSelected(sourcesDirectory, source.name, source.size);
    if (bytes.length !== source.size || sha256(bytes) !== source.sha256) throw new Error('Bytes do snapshot divergentes.');
    if (/\.csv$/i.test(source.name)) {
      const reparsed = parseLegacyCsv(bytes);
      if (!isDeepStrictEqual(reparsed, manifest.parsed)) throw new Error('Projeção do snapshot divergente.');
      if (!isDeepStrictEqual(expectedDiff(reparsed, manifest.comparison), manifest.diff)) throw new Error('Comparação do snapshot divergente.');
    }
  }
  for (const [name, data] of [['manifest.json', manifest], ['diff.json', manifest.diff]] as const) {
    const expected = Buffer.from(JSON.stringify(data, null, 2) + '\n');
    if (!(await readBoundedFile(directory, name, expected.length)).equals(expected)) throw new Error('Metadados do snapshot divergentes.');
  }
}

/** Sem conexão com banco; copia somente bytes explicitamente selecionados. */
export async function createLegacyPreview(options: PreviewOptions): Promise<{ directory: string; manifest: PreviewManifest }> {
  const startedAt = new Date().toISOString();
  // Captura/valida a base antes de qualquer await; alterações no objeto do chamador
  // não podem trocar a evidência de comparação durante a leitura dos arquivos.
  const comparison = comparisonSchema.parse(options.previous === undefined ? { mode: 'source_only', basis: [] } : { mode: 'captured_prior_state', basis: options.previous });
  const files = z.array(selectedName).min(1).parse(options.files).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (new Set(files.map((file) => file.toLowerCase())).size !== files.length || files.filter((file) => /\.csv$/i.test(file)).length !== 1) throw new Error('Selecione exatamente um CSV e controles distintos.');
  const sourceDir = await realpath(options.sourceDir);
  // Exige destino existente para resolver junctions/symlinks antes de qualquer escrita.
  const privateDir = await realpath(options.privateDir);
  const project = await realpath(projectDirectory);
  const gitCommon = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repository = await realpath(path.dirname(path.resolve(project, gitCommon)));
  if (within(project, privateDir) || within(repository, privateDir) || within(sourceDir, privateDir)) throw new Error('O destino deve ser privado e externo ao projeto e à origem.');
  // Confere todos os tamanhos antes de carregar qualquer arquivo selecionado.
  let declaredSize = 0;
  for (const name of files) {
    const stat = await lstat(path.join(sourceDir, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Controle selecionado inválido.');
    declaredSize += stat.size;
    if (stat.size > MAX_SOURCE_ARCHIVE_BYTES || declaredSize > MAX_SOURCE_ARCHIVE_BYTES) throw new Error('A seleção excede 50 MiB.');
  }
  const selected = [];
  let readSize = 0;
  for (const name of files) {
    const bytes = await readSelected(sourceDir, name, MAX_SOURCE_ARCHIVE_BYTES - readSize);
    readSize += bytes.length;
    selected.push({ name, bytes, readAt: new Date().toISOString() });
  }
  const csv = selected.find((s) => /\.csv$/i.test(s.name))!;
  const parsed = parseLegacyCsv(csv.bytes);
  const diff = expectedDiff(parsed, comparison);
  const directory = await mkdtemp(path.join(privateDir, `legacy-preview-${startedAt.slice(0, 10)}-`));
  await mkdir(path.join(directory, 'sources'), { mode: 0o700 });
  const sources = [];
  for (const item of selected) {
    const snapshotPath = `sources/${item.name}`;
    await writeFile(path.join(directory, snapshotPath), item.bytes, { flag: 'wx', mode: 0o600 });
    const copied = await readBoundedFile(path.join(directory, 'sources'), item.name, item.bytes.length);
    if (!copied.equals(item.bytes)) throw new Error('Cópia divergente.');
    sources.push({ name: item.name, sourcePath: path.join(sourceDir, item.name), snapshotPath, sha256: sha256(copied), size: copied.length, ids: item === csv ? parsed.rows.map((row) => row.legacyId) : [], rowCount: item === csv ? parsed.rows.length : 0, readAt: item.readAt });
  }
  const manifest = manifestSchema.parse({ formatVersion: 2, mode: 'preview', importerVersion: IMPORTER_VERSION, parserVersion: PARSER_VERSION, sourceSetHash: sourceSetHash(sources), startedAt, completedAt: new Date().toISOString(), snapshotDirectory: directory, writerFreeze: false, requiresSourceRecheckBeforeApply: true, sources, parsed, comparison, diff });
  if ((await findOriginalSourceDrift(manifest)).length) throw new Error('Origem alterada durante a prévia; repita a captura.');
  await writeFile(path.join(directory, 'diff.json'), JSON.stringify(legacyDiffSchema.parse(diff), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await verifyPreviewArtifact(manifest);
  return { directory, manifest };
}

async function main(args: string[]) {
  try {
    if (args.shift() !== 'preview') throw new Error('Somente preview está disponível.');
    let sourceDir: string | undefined;
    let privateDir: string | undefined;
    const files: string[] = [];
    while (args.length) {
      const key = args.shift(); const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('Argumentos incompletos.');
      if (key === '--source-dir' && sourceDir === undefined) sourceDir = value;
      else if (key === '--private-dir' && privateDir === undefined) privateDir = value;
      else if (key === '--file') files.push(value);
      else throw new Error('Argumento inválido.');
    }
    if (!sourceDir || !privateDir) throw new Error('Diretórios obrigatórios.');
    const { manifest } = await createLegacyPreview({ sourceDir, privateDir, files });
    console.log(`Prévia privada: ${manifest.sources.length} arquivos, ${manifest.parsed.rows.length} registros, ${manifest.parsed.issues.filter((i) => i.severity === 'error').length} erros, ${manifest.parsed.issues.filter((i) => i.severity === 'warning').length} avisos. Consulte o manifesto no destino privado.`);
    process.exitCode = manifest.parsed.blocked ? 2 : 0;
  } catch {
    console.error('Não foi possível gerar a prévia privada. Verifique diretórios externos, seleção explícita e argumentos. Nenhum dado foi importado.');
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
