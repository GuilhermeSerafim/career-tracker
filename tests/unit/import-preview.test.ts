import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { comparisonSchema, createLegacyPreview, manifestSchema, findOriginalSourceDrift, verifyPreviewArtifact } from '../../scripts/import-legacy';
import { parseLegacyCsv, sha256, type LegacyDiff } from '../../domain/import';
import { MAX_SOURCE_ARCHIVE_BYTES } from '../../shared/transfer';

const project = fileURLToPath(new URL('../../', import.meta.url));
// Execução deliberadamente privada: nunca gera manifests dentro do projeto.
const privateTestRoot = path.join(tmpdir(), 'career-preview-fixtures');
async function setup() {
  await mkdir(privateTestRoot, { recursive: true });
  const base = await mkdtemp(path.join(privateTestRoot, 'run-'));
  const source = path.join(base, 'input');
  const output = path.join(base, 'output');
  await mkdir(source); await mkdir(output);
  const csv = await readFile(new URL('../fixtures/legacy.csv', import.meta.url));
  await writeFile(path.join(source, 'legacy.csv'), csv);
  await writeFile(path.join(source, 'review.md'), 'Revisão fictícia 🧭\r\n');
  await writeFile(path.join(source, 'unselected.pdf'), 'NÃO COLETAR');
  return { base, source, output, csv };
}

describe('preview privado sem banco de dados', () => {
  it('base de comparação tem modo explícito, limite de registros e teto independente de 50 MiB', () => {
    const state = { legacyId: 'V901', rawRowHash: 'a'.repeat(64), importedApplicationVersion: 1, currentApplicationVersion: 1 };
    expect(() => comparisonSchema.parse({ mode: 'source_only', basis: [state] })).toThrow();
    expect(comparisonSchema.parse({ mode: 'captured_prior_state', basis: [] })).toEqual({ mode: 'captured_prior_state', basis: [] });
    expect(() => comparisonSchema.parse({ mode: 'captured_prior_state', basis: Array.from({ length: 100_001 }, (_, index) => ({ ...state, legacyId: `V${index}` })) })).toThrow();
    const oversized = comparisonSchema.safeParse({ mode: 'captured_prior_state', basis: Array.from({ length: 100_000 }, (_, index) => ({ ...state, legacyId: 'V' + String(index).padStart(499, '0') })) });
    expect(oversized.success).toBe(false);
    if (!oversized.success) expect(oversized.error.issues.map((issue) => issue.message)).toContain('A base de comparação excede 50 MiB.');
  }, 20_000);

  it('copia a base anterior antes da leitura assíncrona e mantém modo capturado para base vazia', async () => {
    const { source, output, csv } = await setup();
    const previous = [{ legacyId: 'V901', rawRowHash: parseLegacyCsv(csv).rows[0]!.rawRowHash, importedApplicationVersion: 1, currentApplicationVersion: 1 }];
    const promise = createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv'], previous });
    previous[0]!.currentApplicationVersion = 2;
    const { manifest } = await promise;
    expect(manifest.diff).toEqual([{ legacyId: 'V901', kind: 'unchanged' }]);
    expect(manifest.comparison.basis[0]?.currentApplicationVersion).toBe(1);
    const empty = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv'], previous: [] });
    expect(empty.manifest.comparison).toEqual({ mode: 'captured_prior_state', basis: [] });
    expect(empty.manifest.diff).toEqual([{ legacyId: 'V901', kind: 'new' }]);
    expect(empty.manifest.sourceSetHash).toBe(manifest.sourceSetHash);
  });

  it.each([
    { label: 'IDs omitidos', diff: [] },
    { label: 'ID sem relação com a fonte', diff: [{ legacyId: 'V999999', kind: 'unchanged' }] },
    { label: 'classificação alterada', diff: [{ legacyId: 'V901', kind: 'unchanged' }] },
  ] satisfies { label: string; diff: LegacyDiff }[])('rejeita edição coordenada do diff: $label', async ({ diff }) => {
    const { source, output } = await setup();
    const { directory, manifest } = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv'] });
    const tampered = structuredClone(manifest);
    tampered.diff = diff;
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(tampered, null, 2) + '\n');
    await writeFile(path.join(directory, 'diff.json'), JSON.stringify(diff, null, 2) + '\n');
    await expect(verifyPreviewArtifact(tampered)).rejects.toThrow();
  });

  it.each([
    { label: 'inalterada', changedSource: false, changedApp: false, kind: 'unchanged' },
    { label: 'fonte alterada', changedSource: true, changedApp: false, kind: 'source_changed' },
    { label: 'app alterado', changedSource: false, changedApp: true, kind: 'application_changed' },
    { label: 'conflito', changedSource: true, changedApp: true, kind: 'conflict' },
  ])('persiste a base capturada e reproduz classificação $label', async ({ changedSource, changedApp, kind }) => {
    const { source, output, csv } = await setup();
    const row = parseLegacyCsv(csv).rows[0]!;
    const previous = [
      { legacyId: 'V901', rawRowHash: changedSource ? 'a'.repeat(64) : row.rawRowHash, importedApplicationVersion: 2, currentApplicationVersion: changedApp ? 3 : 2 },
      { legacyId: 'V902', rawRowHash: 'b'.repeat(64), importedApplicationVersion: 1, currentApplicationVersion: 1 },
    ];
    const { manifest } = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv'], previous });
    expect(manifest.comparison).toEqual({ mode: 'captured_prior_state', basis: previous });
    expect(manifest.diff).toEqual([{ legacyId: 'V901', kind }, { legacyId: 'V902', kind: 'source_missing' }]);
    await expect(verifyPreviewArtifact(manifest)).resolves.toBeUndefined();
  });

  it('estado capturado inválido/repetido é rejeitado mesmo quando o CSV está bloqueado', async () => {
    const { source, output } = await setup();
    await writeFile(path.join(source, 'legacy.csv'), 'CSV inválido');
    const state = { legacyId: 'V901', rawRowHash: 'a'.repeat(64), importedApplicationVersion: 1, currentApplicationVersion: 1 };
    for (const previous of [[state, state], [{ ...state, rawRowHash: 'inválido' }], [{ ...state, legacyId: 'V' + '1'.repeat(500) }], [{ ...state, currentApplicationVersion: 2_147_483_648 }]]) {
      await expect(createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv'], previous })).rejects.toThrow();
    }
    expect(await readdir(output)).toEqual([]);
  });

  it('fonte bloqueada não produz diff acionável, mesmo com estado anterior capturado', async () => {
    const { source, output } = await setup();
    await writeFile(path.join(source, 'legacy.csv'), 'CSV inválido');
    const previous = [{ legacyId: 'V901', rawRowHash: 'a'.repeat(64), importedApplicationVersion: 1, currentApplicationVersion: 2 }];
    const { directory, manifest } = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv'], previous });
    expect(manifest.diff).toEqual([]);
    await expect(verifyPreviewArtifact(manifest)).resolves.toBeUndefined();
    const tampered = structuredClone(manifest);
    tampered.diff = [{ legacyId: 'V901', kind: 'source_missing' }];
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(tampered, null, 2) + '\n');
    await writeFile(path.join(directory, 'diff.json'), JSON.stringify(tampered.diff, null, 2) + '\n');
    await expect(verifyPreviewArtifact(tampered)).rejects.toThrow();
  });

  it('liga os campos e projeções do manifesto aos bytes brutos, não às cópias editáveis', async () => {
    const { source, output } = await setup();
    const { manifest } = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv'] });
    const tampered = structuredClone(manifest);
    tampered.parsed.rows[0]!.company = 'Empresa adulterada';
    tampered.parsed.rows[0]!.fields.empresa = 'Empresa adulterada';
    tampered.parsed.rows[0]!.provenance.empresa.originalText = 'Empresa adulterada';
    expect(() => manifestSchema.parse(tampered)).toThrow();
  });

  it('verificação completa detecta alteração do snapshot sem confundir com drift da origem', async () => {
    const { source, output } = await setup();
    const { directory, manifest } = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv', 'review.md'] });
    await expect(verifyPreviewArtifact(manifest)).resolves.toBeUndefined();
    const changed = await readFile(path.join(directory, 'sources', 'legacy.csv'));
    changed[changed.length - 3] = changed[changed.length - 3]! ^ 1;
    await writeFile(path.join(directory, 'sources', 'legacy.csv'), changed);
    expect(await findOriginalSourceDrift(manifest)).toEqual([]);
    await expect(verifyPreviewArtifact(manifest)).rejects.toThrow();
  });

  it.each(['manifest.json', 'diff.json', 'sources/review.md'])('verificação completa detecta mudança em %s', async (name) => {
    const { source, output } = await setup();
    const { directory, manifest } = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv', 'review.md'] });
    await writeFile(path.join(directory, name), 'ALTERADO');
    await expect(verifyPreviewArtifact(manifest)).rejects.toThrow();
  });

  it('confere toda a análise semântica do CSV copiado, inclusive avisos removidos do manifesto', async () => {
    const { source, output } = await setup();
    const { directory, manifest } = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv'] });
    const tampered = structuredClone(manifest);
    tampered.parsed.issues = [];
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(tampered, null, 2) + '\n');
    await expect(verifyPreviewArtifact(tampered)).rejects.toThrow('Projeção');
  });

  it.each([-1, 0, 1])('limita total selecionado: 50 MiB com ajuste de %i bytes', async (delta) => {
    const { source, output, csv } = await setup();
    await writeFile(path.join(source, 'review.md'), Buffer.alloc(MAX_SOURCE_ARCHIVE_BYTES - csv.length + delta, 'x'));
    const promise = createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv', 'review.md'] });
    if (delta > 0) {
      await expect(promise).rejects.toThrow();
      expect(await readdir(output)).toEqual([]);
    } else {
      const result = await promise;
      expect(result.manifest.sources.reduce((sum, item) => sum + item.size, 0)).toBe(MAX_SOURCE_ARCHIVE_BYTES + delta);
    }
  }, 30_000);

  it('CLI rejeita arquivo acima do teto antes de criar snapshot', async () => {
    const { source, output } = await setup();
    const handle = await open(path.join(source, 'review.md'), 'w');
    await handle.truncate(MAX_SOURCE_ARCHIVE_BYTES + 1); await handle.close();
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/import-legacy.ts', 'preview', '--source-dir', source, '--private-dir', output, '--file', 'legacy.csv', '--file', 'review.md'], { cwd: project, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(await readdir(output)).toEqual([]);
  }, 20_000);

  it('copia só os controles selecionados e grava manifest/diff validados e determinísticos', async () => {
    const { source, output, csv } = await setup();
    const before = await readFile(path.join(source, 'legacy.csv'));
    const first = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['review.md', 'legacy.csv'] });
    const anotherOutput = path.join(output, 'another-output');
    await mkdir(anotherOutput);
    const second = await createLegacyPreview({ sourceDir: source, privateDir: anotherOutput, files: ['legacy.csv', 'review.md'] });
    expect(first.directory).not.toBe(second.directory);
    expect(first.manifest.sourceSetHash).toBe(second.manifest.sourceSetHash);
    expect(first.manifest.comparison).toEqual({ mode: 'source_only', basis: [] });
    expect(first.manifest.sources.map((s) => s.name)).toEqual(['legacy.csv', 'review.md']);
    expect(first.manifest.sources[0]).toMatchObject({ sha256: sha256(csv), size: csv.length, ids: ['V901'], rowCount: 1 });
    expect(first.manifest.parsed.rows[0]?.rawRowHash).toBe(sha256(csv.subarray(first.manifest.parsed.rows[0]!.byteStart)));
    expect(await readFile(path.join(first.directory, 'sources', 'legacy.csv'))).toEqual(csv);
    expect(await readFile(path.join(source, 'legacy.csv'))).toEqual(before);
    const disk = JSON.parse(await readFile(path.join(first.directory, 'manifest.json'), 'utf8'));
    expect(manifestSchema.parse(disk)).toEqual(first.manifest);
    const tampered = structuredClone(disk);
    tampered.parsed.rows[0].raw += 'alteração';
    expect(() => manifestSchema.parse(tampered)).toThrow();
    expect(JSON.parse(await readFile(path.join(first.directory, 'diff.json'), 'utf8'))).toEqual([{ legacyId: 'V901', kind: 'new' }]);
    await expect(readFile(path.join(first.directory, 'sources', 'unselected.pdf'))).rejects.toThrow();
    expect(await findOriginalSourceDrift(first.manifest)).toEqual([]);
    await writeFile(path.join(source, 'review.md'), 'alterada');
    expect(await findOriginalSourceDrift(first.manifest)).toEqual(['review.md']);
    const changed = await createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv', 'review.md'] });
    expect(changed.manifest.sourceSetHash).not.toBe(first.manifest.sourceSetHash);
  });

  it('protege a raiz do repositório principal, worktree e diretório de origem', async () => {
    const { source } = await setup();
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: project, encoding: 'utf8' }).trim();
    const main = path.dirname(path.resolve(project, common));
    for (const privateDir of [project, main, source]) {
      await expect(createLegacyPreview({ sourceDir: source, privateDir, files: ['legacy.csv'] })).rejects.toThrow();
    }
  });

  it.each([[], ['../legacy.csv'], ['legacy.csv', 'legacy.csv'], ['unselected.pdf'], ['review.md'], ['legacy.csv', 'manifest.json']].map((files) => ({ files })))('rejeita seleção não explícita/ambígua/insegura $files', async ({ files }) => {
    const { source, output } = await setup();
    await expect(createLegacyPreview({ sourceDir: source, privateDir: output, files })).rejects.toThrow();
  });

  it('rejeita symlink selecionado ou saída que resolve para o repositório', async () => {
    const { base, source, output } = await setup();
    // Junction funciona no Windows sem Developer Mode.
    await symlink(project, path.join(base, 'public-output'), 'junction');
    await expect(createLegacyPreview({ sourceDir: source, privateDir: path.join(base, 'public-output'), files: ['legacy.csv'] })).rejects.toThrow();
    await mkdir(path.join(source, 'folder.md'));
    await expect(createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv', 'folder.md'] })).rejects.toThrow();
    await symlink(output, path.join(source, 'escape.md'), 'junction');
    await expect(createLegacyPreview({ sourceDir: source, privateDir: output, files: ['legacy.csv', 'escape.md'] })).rejects.toThrow();
  });

  it('CLI funciona com fixture e só expõe contagens; erros não imprimem conteúdo/caminhos', async () => {
    const { source, output } = await setup();
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/import-legacy.ts', ...args], { cwd: project, encoding: 'utf8' });
    const ok = run('preview', '--source-dir', source, '--private-dir', output, '--file', 'legacy.csv', '--file', 'review.md');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Prévia privada');
    for (const text of ['V901', 'Empresa', source, output, 'Relato']) expect(ok.stdout + ok.stderr).not.toContain(text);
    await writeFile(path.join(source, 'legacy.csv'), 'CONTEÚDO PRIVADO inválido');
    const invalid = run('preview', '--source-dir', source, '--private-dir', output, '--file', 'legacy.csv');
    expect(invalid.status).toBe(2);
    expect(invalid.stdout + invalid.stderr).not.toContain('CONTEÚDO PRIVADO');
    const refused = run('apply', '--source-dir', source, '--private-dir', output, '--file', 'legacy.csv');
    expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).not.toContain(source);
  }, 20_000); // Três processos Node reais; sob a suíte inteira excedem 5 s no Windows.
});
