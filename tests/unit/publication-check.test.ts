import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkPublication } from '../../scripts/publication-check';

const script = fileURLToPath(new URL('../../scripts/publication-check.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const marker = ['private', 'case', '371'].join('-');
let fixture: string, root: string, terms: string;
function git(...args: string[]) {
  // Fixture commit metadata must come from its isolated repository, even when
  // the invoking release shell specifies a different author for its own export.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(AUTHOR|COMMITTER)_/i.test(key)));
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function set(path: string, value: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function commit(message = 'Fictional example') {
  git('add', '-A'); git('commit', '-qm', message);
}
function scan() { return checkPublication(root, terms); }

function runCli(ref = 'HEAD', exceptionsFile?: string) {
  return spawnSync(process.execPath, ['--import', tsx, script, '--ref', ref], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PUBLICATION_TERMS_FILE: terms, PUBLICATION_EXCEPTIONS_FILE: exceptionsFile },
  });
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'career-publication-'));
  root = join(fixture, 'repo'); mkdirSync(root);
  git('init', '-q'); git('config', 'user.name', 'Example');
  git('config', 'user.email', 'example@example.invalid'); git('config', 'commit.gpgSign', 'false');
  terms = join(fixture, 'terms'); writeFileSync(terms, marker);
  set('README.md', 'Fictional project\n'); commit();
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

it('checks only the selected complete ancestry, binding the result to the commit, tree and checkout', () => {
  set('docs/design.md', 'Public architecture'); commit(marker);
  const dev = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const clean = git('commit-tree', tree, '-m', 'Reviewed public source');
  git('update-ref', 'refs/heads/reviewed', clean);
  const published = checkPublication(root, terms, 'refs/heads/reviewed');
  expect(published).toMatchObject({ commit: clean, tree, commits: 1, files: 2, failures: {} });
  expect(git('rev-parse', 'HEAD')).toBe(dev);
});
it('checks commit messages and author metadata even when the selected tree is public', () => {
  git('config', 'user.name', marker);
  git('config', 'user.email', 'person' + '@' + 'unreserved.demo');
  git('commit', '--allow-empty', '-qm', marker);
  expect(scan().failures).toMatchObject({ 'termo privado': 1, contato: 1 });
});

it('rejects a removed forbidden file and a previous version of a permitted file', () => {
  set('docs/design.md', marker);
  set('backup.dump', 'synthetic bytes'); commit();
  rmSync(join(root, 'backup.dump')); set('docs/design.md', 'public'); commit();
  const result = scan();
  expect(result.commits).toBe(3);
  expect(result.failures['arquivo fora da lista']).toBeGreaterThan(0);
  expect(result.failures['termo privado']).toBeGreaterThan(0);
});

it('rejects whole private terms and executable credentials in the working copy', () => {
  writeFileSync(terms, 'word:' + marker);
  set('README.md', [marker, 'gh' + 'p_' + 'A'.repeat(36)].join('\n'));
  expect(scan().failures).toMatchObject({ 'assinatura sensível': 1, 'termo privado': 1, 'árvore divergente': 1 });
});

it.each([
  ['URL autenticada', 'https://' + 'x:y@service.example.invalid/'],
  ['parâmetro de acesso', 'https://service.example.invalid/?' + 'access_' + 'token=' + 'fixture-code'],
  ['configuração de segredo', 'PRIVATE_' + 'API_KEY' + '=unique-synthetic-key'],
  ['token de agente', 'ct_' + 'agent_' + 'a'.repeat(36) + '.' + 'B'.repeat(43)],
  ['contato fora dos domínios fictícios', 'person' + '@' + 'unreserved-domain.demo'],
  ['PDF com extensão permitida', '%' + 'PDF-' + '1.7'],
  ['banco com extensão permitida', 'SQLite format 3' + '\0demo'],
  ['dump SQL com extensão permitida', '-- PostgreSQL database ' + 'dump\n'],
])('rejeita %s em um arquivo permitido', (_label, content) => {
  set('README.md', content); commit();
  expect(Object.keys(scan().failures).length).toBeGreaterThan(0);
});

it('rejects a junction in a publishable directory without reading its external target', () => {
  const external = join(fixture, 'external');
  mkdirSync(external); writeFileSync(join(external, 'design.md'), marker);
  symlinkSync(external, join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = scan();
  expect(result.failures['link no disco']).toBe(1);
  expect(result.failures['termo privado']).toBeUndefined();
});

it('rejects a historical symbolic link using its Git mode after its deletion', () => {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '../external', encoding: 'utf8' }).trim();
  git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',docs/design.md');
  git('commit', '-qm', 'Example link'); git('rm', '--cached', 'docs/design.md'); git('commit', '-qm', 'Remove link');
  expect(scan().failures['modo de arquivo']).toBeGreaterThan(0);
});

it('requires external terms and rejects an index different from disk or hidden by index flags', () => {
  writeFileSync(join(root, 'terms'), marker);
  expect(() => checkPublication(root, join(root, 'terms'))).toThrow();
  rmSync(join(root, 'terms')); set('README.md', marker); git('add', 'README.md'); set('README.md', 'Fictional project\n');
  expect(scan().failures['árvore divergente']).toBe(1);
});
it('rejects unchecked portions of the index', () => {
  git('update-index', '--assume-unchanged', 'README.md');
  expect(scan().failures['índice incompleto']).toBe(1);
});

const inventedPath = 'docs/design.md';
const inventedTerm = 'apricot-lantern';
const inventedField = 'display_mode: "apricot-lantern-v2"';
const inventedSource = '{ ' + inventedField + ' }\n';
function reviewFixture(source = inventedSource) {
  const rule = { path: inventedPath, term: inventedTerm, fragment: inventedField,
    sourceSha256: createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex') };
  const file = join(fixture, 'review.json');
  writeFileSync(terms, inventedTerm);
  writeFileSync(file, JSON.stringify([rule]));
  set(inventedPath, source); commit();
  return { file, rule };
}

it('uses one externally reviewed field and requires a new review if its source changes', () => {
  const { file } = reviewFixture();
  set(inventedPath, '\n' + inventedSource);
  const checked = runCli('HEAD', file);
  expect(checked.status).toBe(1);
  // The original blob is approved. Only the changed checkout reports a private term.
  expect(JSON.parse(checked.stdout).failures).toEqual({ 'termo privado': 1, 'árvore divergente': 1 });
  expect(checked.stdout + checked.stderr).not.toContain(inventedTerm);
});

it.each([
  ['neighboring occurrence', inventedSource + 'heading: "' + inventedTerm + '"', '', 'termo privado'],
  ['different field name with the same suffix', '{ secondary_' + inventedField + ' }', '', 'termo privado'],
  ['repeated field', inventedSource + inventedSource, '', 'termo privado'],
  ['different dictionary term inside the field', inventedSource, 'v2', 'termo privado'],
  ['independent signature', inventedSource + 'gh' + 'p_' + 'A'.repeat(36), '', 'assinatura sensível'],
])('preserves %s even with an exact source digest', (_label, source, otherTerm, reason) => {
  const { file } = reviewFixture(source);
  if (otherTerm) writeFileSync(terms, inventedTerm + '\n' + otherTerm);
  expect(checkPublication(root, terms, 'HEAD', file).failures[reason]).toBe(2);
});

it('checks other paths and older source contexts independently', () => {
  const old = 'previous\n' + inventedSource;
  set(inventedPath, old); commit();
  const { file } = reviewFixture();
  set('README.md', inventedSource);
  const result = checkPublication(root, terms, 'HEAD', file);
  expect(result.failures).toEqual({ 'termo privado': 2, 'árvore divergente': 1 });
});

it('rejects malformed, broad, and unregistered external rules', () => {
  const { file, rule } = reviewFixture();
  for (const invalid of [
    '*', [null], [{ ...rule, path: 'docs/*' }], [{ ...rule, fragment: inventedTerm }],
    [{ ...rule, fragment: inventedField + ', other: "extra"' }], [{ ...rule, term: 'other' }],
    [{ ...rule, sourceSha256: '*' }], [{ ...rule, extra: true }], [rule, rule],
  ]) {
    writeFileSync(file, JSON.stringify(invalid));
    expect(() => checkPublication(root, terms, 'HEAD', file)).toThrow();
  }
});

it('requires the review configuration outside all working trees and Git metadata', () => {
  const linked = join(fixture, 'linked');
  git('worktree', 'add', '--quiet', '--detach', linked, 'HEAD');
  const misplaced = join(root, '.git', 'review.json');
  writeFileSync(misplaced, '[]');
  expect(() => checkPublication(linked, terms, 'HEAD', misplaced)).toThrow();
  set('docs/rules.json', '[]');
  expect(() => checkPublication(linked, terms, 'HEAD', join(root, 'docs', 'rules.json'))).toThrow();
});

it('returns a failing CLI status with no private content or filenames in either output stream', () => {
  set(marker + '.pdf', marker); commit();
  const result = runCli();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('arquivo fora da lista');
  expect(result.stdout + result.stderr).not.toContain(marker);
});

it('rejects a shallow clone even when its materialized tree is public', () => {
  set('docs/design.md', 'Public design'); commit();
  const shallow = join(fixture, 'shallow');
  git('clone', '--quiet', '--depth', '1', pathToFileURL(root).href, shallow);
  expect(git('-C', shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
  expect(() => checkPublication(shallow, terms)).toThrow();
});

it('preserves harmless word fragments while blocking a standalone private term', () => {
  writeFileSync(terms, 'word:' + marker);
  set('README.md', 'prefix' + marker + 'suffix'); commit();
  expect(scan().failures).toEqual({});
});

const fakeValue = 'fabricated-scanner-canary';
const exampleUrl = 'https://example.invalid/callback';
it.each([
  ['unquoted punctuation', 'POSTGRES_PASSWORD', '=', 'Only!ForScanner35'],
  ['embedded environment assignment', 'env LANG=C POSTGRES_PASSWORD', '=', 'Only!ForScanner35'],
  ['commented example with BOM', '\uFEFF# export Db_Password', ' = ', 'Only!ForScanner35'],
  ['short quoted value', 'export api_key', ' = ', '"!"'],
  ['short punctuation-only value', 'APP_CLIENT_SECRET', '=', '$'],
  ['mixed-case YAML with trailing punctuation', '  Db_Password', ': ', 'Only!ForScanner;'],
  ['OIDC fragment', exampleUrl + '#id_token', '=', fakeValue],
  ['signed Google query', exampleUrl + '?X-Goog-Signature', '=', fakeValue],
  ['signed Google fragment', exampleUrl + '#x-goog-credential', '=', fakeValue],
  ['encoded OIDC name after another parameter', exampleUrl + '?unused=ok&ID%5fTOKEN', '=', fakeValue],
  ['leading question mark in query password', exampleUrl + '?password', '=', '?fictional-review-value'],
  ['question-mark-only query value', exampleUrl + '?password', '=', '?'],
  ['nested callback with a question-mark-prefixed password', exampleUrl + '?next=' + exampleUrl + '?password', '=', '?fictional-review-value'],
  ['nested callback with an existing credential name', exampleUrl + '?next=' + exampleUrl + '?access_token', '=', fakeValue],
  ['OAuth client secret', exampleUrl + '#client_secret', '=', fakeValue],
])('blocks %s in committed public configuration without logging the input', (_name, field, separator, raw) => {
  const input = field + separator + raw;
  set('.env.example', input + '\n'); git('add', '--', '.env.example');
  const ref = git('commit-tree', git('write-tree'), '-m', 'Synthetic public fixture');
  const result = runCli(ref);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ commit: ref, commits: 1, failures: { 'credencial ou URL privada': 2 } });
  expect(result.stdout + result.stderr).not.toContain(input);
  if (raw.length > 3) expect(result.stdout + result.stderr).not.toContain(raw);
});

it('accepts empty environment templates and empty credential parameters', () => {
  set('.env.example', [
    'POSTGRES_PASSWORD' + '=', 'export API_KEY' + '=   # pending',
    'CLIENT_SECRET' + '="" # pending', 'AUTH_TOKEN' + "='' # pending",
    exampleUrl + '#id_token' + '=', exampleUrl + '?X-Goog-Signature' + '=',
    exampleUrl + '?password' + '=&view=public', exampleUrl + '?password' + '=#display',
  ].join('\n'));
  commit();
  expect(scan().failures).toEqual({});
});

it('binds the full value, including a question-mark suffix, to an approved example fingerprint', () => {
  const path = 'src/lib/links.test.ts';
  const reviewed = readFileSync(new URL('../../src/lib/links.test.ts', import.meta.url), 'utf8');
  const changed = reviewed.replace(/([?]token=[\w-]+)/, '$1?fixture-suffix');
  expect(changed !== reviewed).toBe(true);
  set(path, reviewed); commit();
  set(path, changed);
  expect(scan().failures).toEqual({ 'credencial ou URL privada': 1, 'árvore divergente': 1 });
});
