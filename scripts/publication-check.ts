import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// New public paths require an explicit change and editorial review.
const groups = [
  ['', '.env.example .gitattributes .gitignore .npmrc .nvmrc README.md eslint.config.js index.html package-lock.json package.json playwright.config.ts tsconfig.app.json tsconfig.base.json tsconfig.json tsconfig.server.json vercel.json vite.config.ts vitest.config.ts vitest.integration.config.ts'],
  ['.github/workflows', 'checks.yml'],
  ['api', 'index.ts'],
  ['docs', 'activity-services.md agent-api.md application-services.md design.md http-api.md legacy-preview.md operations.md private-transfers.md reviews.md security.md technical-fixture-maintenance.md verification.md'],
  ['domain', 'cycles.ts dates.ts export.ts identity.ts import.ts metrics.ts review-markdown.ts'],
  ['scripts', 'agent-client.ts audit-local.ts check-api-runtime.mjs check-build.ts cutover-check.ts export-private.ts import-legacy.ts local-db.ts private-transfer-io.ts provision-owner.ts publication-check.ts restore-private.ts run-e2e.ts verify-local.mjs'],
  ['server', 'agent-policy.ts app.ts auth.ts config.ts database.ts dev.ts errors.ts input.ts logger.ts mutation.ts runtime.ts security-policy.ts unavailable.ts'],
  ['server/repositories', 'activity.ts career.ts identities.ts reviews.ts transfer-preflight.ts transfers.ts'],
  ['server/routes', 'maintenance.ts read.ts transfer.ts write.ts'],
  ['server/services', 'activity.ts applications.ts credentials.ts exports.ts imports.ts reviews.ts'],
  ['shared', 'agent-credentials.ts analytics.ts application-results.ts commands.ts model.ts queries.ts transfer.ts'],
  ['src/app', 'App.tsx Shell.tsx query.ts runtime.ts validation.ts'],
  ['src/components', 'AsyncState.tsx ConflictDialog.tsx DateField.tsx SafeLink.tsx session.css'],
  ['src/features/analytics', 'AnalyticsPage.tsx Chart.tsx ChartTable.tsx analytics.css metadata.ts options.ts'],
  ['src/features/applications', 'ActivityForm.tsx ApplicationActions.tsx ApplicationForm.tsx DetailPage.tsx Filters.tsx ListPage.tsx ResumeCreator.tsx application-data.ts applications.css'],
  ['src/features/auth', 'LoginPage.tsx'],
  ['src/features/reviews', 'EditorActions.tsx ReviewsPage.tsx editor.ts reviews.css'],
  ['src/features/settings', 'AgentCredentials.tsx SettingsPage.tsx credential-session.ts transfer-client.ts'],
  ['src/features/today', 'TodayPage.tsx today-data.ts today.css'],
  ['src/lib', 'api.ts auth.ts links.test.ts links.ts'],
  ['src', 'main.tsx'],
  ['src/styles', 'global.css tokens.css'],
  ['supabase', '.gitignore config.toml'],
  ['supabase/migrations', '20261116003352_model_career_records_and_provenance.sql 20261116010237_restrict_career_data_to_configured_owner.sql 20261116014818_make_career_mutations_atomic_and_repeatable.sql 20261116133302_preserve_application_identity_and_corrections.sql 20261116154155_close_and_rectify_versioned_application_reviews.sql 20261116173420_import_legacy_records_with_durable_baselines.sql 20261116184127_export_and_restore_complete_private_history.sql 20261119175518_audited_technical_fixture_maintenance.sql'],
  ['supabase/schemas', '001_model.sql 002_security.sql 003_audit.sql 004_applications.sql 005_reviews.sql 006_imports.sql 007_transfers.sql 008_fixture_maintenance.sql'],
  ['tests/e2e', 'accessibility.spec.ts career.spec.ts security.spec.ts'],
  ['tests/fixtures', 'career.ts legacy.csv review.md'],
  ['tests/helpers', 'agent.ts api.ts command-budget.ts database-client-failure.ts database.ts integration-lifecycle.ts review-scenario.ts synthetic-browser.ts synthetic-career.ts today-scenario.ts'],
  ['tests/integration', 'activity.test.ts agent-access.test.ts analytics-explain.test.ts application-detail.test.ts applications.test.ts contact-catalog.test.ts contacts.test.ts database-failures.test.ts http-boundaries.test.ts http.test.ts imports.test.ts mutation-audit.test.ts mutations.test.ts review-ui-contract.test.ts reviews.test.ts security.test.ts transfer-preflight.test.ts transfers.test.ts'],
  ['tests/maintenance', 'technical-fixture.test.ts'],
  ['tests/ui', 'agent-credentials.test.tsx charts.test.tsx controls.test.tsx detail.test.tsx forms.test.tsx reviews-settings.test.tsx session.test.tsx shell.test.tsx today.test.tsx transfer-client.test.tsx'],
  ['tests/unit', 'agent-auth.test.ts agent-client.test.ts auth.test.ts build-privacy.test.ts contracts.test.ts cutover-check.test.ts cycles.test.ts database-boundary.test.ts dates.test.ts export.test.ts identity.test.ts import-bounds.test.ts import-preview.test.ts import.test.ts local-db-connection.test.ts local-db.test.ts metrics.test.ts mutation.test.ts private-transfer-io.test.ts publication-check.test.ts restore-target.test.ts security-policy.test.ts server-config.test.ts snapshot.test.ts transfer-preservation.test.ts'],
] as const;
const allowed = new Set(groups.flatMap(([dir, names]) => names.split(' ').map(name => dir ? dir + '/' + name : name)));
const dirs = new Set<string>();
for (const file of allowed) {
  for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) dirs.add(dir.replaceAll('\\', '/'));
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxFile = 2 * 1024 * 1024;
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function git(root: string, args: string[], input?: string): Buffer {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    cwd: root, input, maxBuffer: 24 * 1024 * 1024, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw Error('git');
  return result.stdout;
}

function zeroList(data: Buffer): string[] {
  if (!data.length) return [];
  if (data.at(-1) !== 0) throw Error('incomplete list');
  return decoder.decode(data.subarray(0, -1)).split('\0');
}

function inside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

type FieldException = { path: string; term: string; fragment: string; sourceSha256: string; termOffset: number };
type ReviewInput = { terms: string[]; exceptions: FieldException[] };

function readExternalFile(file: string, excludedRoots: string[]): string {
  if (!file || !isAbsolute(file)) throw Error('review file');
  const actual = realpathSync(file);
  if (excludedRoots.some(dir => inside(dir, actual) || inside(dir, resolve(file)))) throw Error('review file');
  const stat = lstatSync(actual);
  if (!stat.isFile() || !stat.size || stat.size > maxFile) throw Error('review file');
  return decoder.decode(readFileSync(actual));
}

function parseExceptions(text: string, terms: string[]): FieldException[] {
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) throw Error('review rules');
  const seen = new Set<string>();
  return entries.map((entry: unknown) => {
    if (typeof entry !== 'object' || !entry || Object.keys(entry).sort().join(',') !== 'fragment,path,sourceSha256,term') throw Error('review rule');
    const { path, term, fragment, sourceSha256 } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || !allowed.has(path) || typeof term !== 'string' || !terms.includes(term) ||
        typeof fragment !== 'string' || typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw Error('review rule');
    const label = /^[a-z_$][\w$]*: (['"])([a-z\d._-]+)\1$/i.exec(fragment)?.[2];
    const index = label?.toLowerCase().indexOf(term) ?? -1;
    const key = path + '\0' + term;
    if (!label || index < 0 || label.toLowerCase().lastIndexOf(term) !== index || seen.has(key)) throw Error('review rule');
    seen.add(key);
    return { path, term, fragment, sourceSha256, termOffset: fragment.length - 1 - label.length + index };
  });
}

function loadReview(root: string, commonDir: string, file: string, exceptionsFile?: string): ReviewInput {
  const roots = zeroList(git(root, ['worktree', 'list', '--porcelain', '-z']))
    .filter(line => line.startsWith('worktree ')).map(line => realpathSync(line.slice(9)));
  roots.push(realpathSync(commonDir));
  const terms = readExternalFile(file, roots).split(/\r?\n/).map(s => s.trim().normalize('NFKC').toLowerCase()).filter(Boolean);
  if (!terms.length || terms.includes('word:')) throw Error('terms');
  const exceptions = exceptionsFile === undefined ? [] : parseExceptions(readExternalFile(exceptionsFile, roots), terms);
  return { terms, exceptions };
}

const signatures = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sb_secret_[\w-]{12,}|sk-(?:proj-)?[\w-]{20,}|xox[baprs]-[\w-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[\w-]{35}|npm_[A-Za-z0-9]{36})\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
  /\b(?:[A-Z]:[\\/]+Users[\\/]+[\w. -]+|\/(?:home|Users)\/[\w.-]+)[\\/]/i,
  /(?:^|\n)(?:-- PostgreSQL database (?:cluster )?dump|COPY [^\n]{1,200} FROM stdin;|BEGIN TRANSACTION;\r?\nCREATE TABLE)/i,
];

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

// Each digest binds one path and its complete set of reviewed synthetic credential-like
// examples or source expressions. Adding a different literal invalidates the digest.
const reviewedExamples = new Set([
  // .env.example
  "9bf4ba8784e4f0ce58d9c9d9e0433dde8a533f36a21d825493e8c4acf48b1a40",
  // .github/workflows/checks.yml
  "cb4ebe51a6dcd597f2e5a9789c0ccacee1507dc304dba2a7f4d5c1c117da65c8",
  // scripts/local-db.ts
  "6cb705fc23b572002ec164fc015499af1cd41866064d2e422a155fbc4357dcb1",
  // scripts/provision-owner.ts
  "bf817d6bd0df4a0c62b5bf3ba80bd3e54e308fa119af574f320a4abf6fab46bb",
  // scripts/verify-local.mjs
  "566a7f0541d56bce62b9693f4daa69554f265351aaba491bb7995aba70799efa",
  // server/app.ts
  "96c1e617f49e0f58df6a5284fca7ff483ae7048a7678ad5e2b8d74fbb18d6c4b",
  // server/auth.ts
  "24539503fe1af81ea69a653a2032878748feec83fbde59ea15ba2e3772f1575e",
  // src/lib/auth.ts
  "7506373d711eda8ee320fb41050eeb8c4e1626521c63553b25f11ffc155617bc",
  // src/lib/links.test.ts
  "5b0462b59218f294fbd2e8a38398aff6e46ccc3059123c690d1850b88033379f",
  // supabase/config.toml
  "bd31743e236ec20135720fabaf55519b54022629e47c3b0b669f619ed7cc47b3",
  // tests/e2e/career.spec.ts
  "077940300c55e63df923aca3a1c8e3331ec128219a01fc0f5ab0d8da10e6fd05",
  // tests/e2e/security.spec.ts
  "dde275760027e771951896eab51281bbf693d2d807476b7d1b43aabcc81e2f52",
  // tests/helpers/database-client-failure.ts
  "e692f83128a0371b46a8aad8e905bb7ee277020ba1b2933362a05d148128aa8d",
  // tests/helpers/synthetic-browser.ts
  "131e2ad55560b737b6fa0335b7fc9f75264f6b6be32d962927bfe55dc8c0126c",
  // tests/helpers/synthetic-career.ts
  "f2bb53aa5683a2254f179323ef704763a4c8b0ecf909cf48af35707af93b6aca",
  // tests/helpers/today-scenario.ts
  "c03a04812f296c25b092393fb7e7cda4406b57ac19a9170978f4a334b20940ff",
  // tests/integration/activity.test.ts
  "d77a240de84708c4f1983c0e37c15e959a04a0ec8c5035cc42c5dbc3ed7bb232",
  // tests/integration/agent-access.test.ts
  "7e02ec02100d4a9206debbddd4fa98c30116aebfeb2a631e26825b590c49c594",
  // tests/integration/analytics-explain.test.ts
  "16d58b2e8ac8517915c617727e524db71aabe53d30dfe8a6d40eed06aa0db25a",
  // tests/integration/application-detail.test.ts
  "064863c9204c8783e9cfb534cf0cd2bbc08cb8c1f9e4b6f3ecaefe2fff420fd7",
  // tests/integration/applications.test.ts
  "73479c4a0a93da157280208b56098b8d425443e9744eb6fba163e415f51c8a61",
  // tests/integration/contact-catalog.test.ts
  "1eccee3b605c6ea059e92cc9c4ab04c9bebef24bc33c5b445daa585d08572646",
  // tests/integration/contacts.test.ts
  "efe93b92374f02283dd0666d0a143bccb8c8b969577f94c1cd744a196cd36231",
  // tests/integration/database-failures.test.ts
  "4a66b9af415d879420db68df94ac93baa1ccf5e2ec0a2aee97bb77af881b1174",
  // tests/integration/http-boundaries.test.ts
  "0de5d317f91ee50f1648cdf6eabadfeece7863ba3552fc674cbcd3c8d009981b",
  // tests/integration/http.test.ts
  "b9d22fc9afb8a747555aff9a6af9f139330c41392492f34d9c40ad3d7638c247",
  // tests/integration/imports.test.ts
  "e291b56e19c7d996ca6975040e1de804a3cc93893d95e4025663ccfbec26188d",
  // tests/integration/mutation-audit.test.ts
  "7f29d0d5deeb2a073ebcdb9e3284e32d6ce2f776d43169b7d6396f336c3631ce",
  // tests/integration/mutations.test.ts
  "d0ebf45bfe24ecd4a5f2687ecc26dc9387616cd568a3e298e6eab1e819588005",
  // tests/integration/reviews.test.ts
  "58ac7e4c695eefc867244a966fea8d413368a3da66f16ae1884897c464e91c7f",
  // tests/integration/security.test.ts
  "20158afe3784c4514365dec3932dd6232f602cce9a2f65534225bf6b73d2ca6a",
  // tests/integration/transfer-preflight.test.ts
  "bdc92b1e3990bcaf71bcc70d62f93bca3244821f2324d12ca2848bd64f13ccae",
  // tests/integration/transfers.test.ts
  "55fb3c43d185731d10f6d9994d95bea69380b027f1e79b0faf28596fd682a99a",
  // tests/maintenance/technical-fixture.test.ts
  "b428a2764021a6a1b07c9cce4e42ffa71c90ef75f9edf8e806c0aee225ea1cde",
  // tests/ui/agent-credentials.test.tsx
  "c68b1baef48ad560887757c04a6a14c6074314fb55a96bb270314c900a686c06",
  // tests/ui/charts.test.tsx
  "1ec90b134440b29bb188dfc152c89d9eb52c31b4b94151f344cb79a156b326f2",
  // tests/ui/controls.test.tsx
  "69a7deab99438d3549e3575bb190e3863f0a0f6ad05fdf4c77e2bb49c7100cc6",
  // tests/ui/detail.test.tsx
  "9a8a16d15f10f6d51d99f2d868dd8749ce4dda6c0941533494bdcafa24d61868",
  // tests/ui/forms.test.tsx
  "7cd06300ff643035f396781496f158a94d7e5c3705c31af7ad62c393ce37cbf3",
  // tests/ui/reviews-settings.test.tsx
  "7cdd35771dd6eda4ad8da50e76d641c4f111d45a1efdb482bb3067e41972ce2a",
  // tests/ui/session.test.tsx
  "f4d58a45bd2497d57d62c0215e2bbd758ef2967d8587e99363ad5716bafd7993",
  // tests/ui/shell.test.tsx
  "dabef7cf1ff7074471a450ced5712a8d4b99c24c96972bfeed0c623be6ab07b0",
  // tests/ui/today.test.tsx
  "3b70c0b64a88ef63097e7ee9086b7db827ed690af5c17fc657acc8f44cfba695",
  // tests/ui/transfer-client.test.tsx
  "e1c51f896145af3820942e01b06acb2ba67084960ae26e055b646d8d8088bef8",
  // tests/unit/agent-client.test.ts
  "1778f800f99688c73eadf694e7cc4cd7b677f4f4b016eedfbf48b6873296c0e5",
  // tests/unit/auth.test.ts
  "9e606eb14a957ebac64d1292227ceb9273353dc6ee40fd601d9d735b1276a335",
  // tests/unit/build-privacy.test.ts
  "3d52b8762eac62c781743ecb67c3500dbb1647ba91e2600d2d4a9687e34cb597",
  // tests/unit/contracts.test.ts
  "24d77ec7de257d90d271d68abe6b5807113552de9f3cf394b4b4179b66830bdc",
  // tests/unit/database-boundary.test.ts
  "bdc7ed7aad8064e479cf4a162e248d4e2dfa56dd3945f8e28a88408eb8daeb72",
  // tests/unit/identity.test.ts
  "d4d46f22b59f165c87922d1737765160af2700e0490e6904eedaa0d36720de16",
  // tests/unit/local-db-connection.test.ts
  "37ebac296b34b9839172c7a3b5a6f5853a9d01be2acba14a80d3eb185c172540",
  // tests/unit/local-db.test.ts
  "e5ce7e2a0eada2a63a33544cb759a01d91ab97954fd64236f0a77933575b6e4b",
  // tests/unit/mutation.test.ts
  "c6d5cfcb456d5a5a4fb5df8bc0ffcffafe7c434f2ee7ddc9a744f7ff66adfd12",
  // tests/unit/publication-check.test.ts
  "28694be3c4f10570eadbc10120082d5db20e356bf56f6c43a3eb3a4450d65ac3",
  // tests/unit/restore-target.test.ts
  "bc71d01d52a388dc4a0e23f0a609ec4666e47b23405ffb40d763e1eaf283d790",
  // tests/unit/security-policy.test.ts
  "2b39d237205d68184c7dde8cce06fe84c9ed7c2a17b7e39d0eecc3a4739725b8",
  // tests/unit/server-config.test.ts
  "2a9eab639037a9e04a64ab6f9e19eacd04a9c3373ee70944f6cd40f337e0675f",
]);

const credentialField = /(?:PASSWORD|SECRET(?:_KEY)?|PRIVATE_KEY|TOKEN|API_?KEY|SERVICE_ROLE_KEY|AWS_SECRET_ACCESS_KEY|(?:^|_)(?:PASS|PWD|PASSPHRASE))$/i;
const credentialParameter = /^(?:(?:access|refresh|id|auth|session|oauth)_token|oauth_token_secret|id_token_hint|client_assertion|token|password|api[_-]?key|signature|sig|(?:x-amz|x-goog)-(?:signature|credential|security-token)|client_secret|code(?:_verifier)?)$/i;

function credentialLiterals(value: string) {
  const patterns = [
    /\b(?:https?|postgres(?:ql)?):\/\/[^/\s'"<>@]+:[^/@\s'"<>]+@[^\s/'"<>)\]}]+/gi,
    /(?:^|[\s,{])["']?(?:[A-Z\d_]*(?:PASSWORD|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|AUTH_TOKEN|API_KEY|APIKEY|CLIENT_SECRET|AGENT_TOKEN)|secret|token|password|apiKey|clientSecret)["']?[ \t]*[:=][ \t]*(?:"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[a-z\d_+./=-]{6,}[ \t]*$)/gim,
    /\bBearer[ \t]+[A-Za-z0-9_+./=-]{12,}/gi,
    /\bct_agent_[a-f\d-]{36}\.[\w-]{40,}/gi,
  ];
  const matches = new Set(patterns.flatMap(rule => Array.from(value.matchAll(rule), m => m[0].trim())));

  // Environment and YAML scalar values can be short and contain punctuation.
  // Keep the whole assignment in the fingerprint. Blank templates and comments have no credential.
  const assignments = [
    /^[\uFEFF \t]*(?:#[ \t]*)?(?:export[ \t]+)?([a-z_]\w*)[ \t]*[=:][ \t]*([^\r\n]*)/gim,
    /(?:^|[\s#;"'\x60])([A-Z_][A-Z\d_]*)=("(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^ \t\r\n#;'"\x60]+)/g,
  ];
  for (const rule of assignments) {
    for (const assignment of value.matchAll(rule)) {
      const [, name, raw] = assignment;
      if (!name || raw === undefined || !credentialField.test(name)) continue;
      const rhs = raw.trim();
      if (!rhs || rhs.startsWith('#') || /^(?:''|""|\x60\x60)\s*(?:#.*)?$/.test(rhs)) continue;
      matches.add(assignment[0].trim());
    }
  }

  // Inspect parameter names independently of an unrecognized outer parameter's value.
  // A recognized parameter protects its entire raw value, including any nested query.
  const heads = /[?&#]([\w%.+-]+)=/g;
  const rawValue = /[^\s'"&#<>\x60]+/y;
  let head: RegExpExecArray | null;
  while ((head = heads.exec(value)) !== null) {
    let name: string;
    try { name = decodeURIComponent(head[1]!); } catch { continue; }
    if (!credentialParameter.test(name)) continue;
    rawValue.lastIndex = heads.lastIndex;
    const payload = rawValue.exec(value);
    if (!payload) continue;
    matches.add(head[0] + payload[0]);
    heads.lastIndex = rawValue.lastIndex;
  }
  return [...matches].sort();
}

function containsPrivateTerm(value: string, review: ReviewInput, path: string): boolean {
  const normalized = value.normalize('NFKC').toLowerCase();
  return review.terms.some(entry => {
    const word = entry.startsWith('word:');
    const term = word ? entry.slice(5) : entry;
    if (!normalized.includes(term)) return false;
    if (word) {
      const escaped = term.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
      return new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'u').test(normalized);
    }
    const rule = review.exceptions.find(r => r.path === path && r.term === term);
    if (!rule || digest(value.replaceAll('\r\n', '\n')) !== rule.sourceSha256) return true;
    const position = value.indexOf(rule.fragment);
    if (position < 0 || value.lastIndexOf(rule.fragment) !== position) return true;
    if ((position > 0 && !/[\s,{]/.test(value[position - 1]!)) ||
        (position + rule.fragment.length < value.length && !/[\s,};]/.test(value[position + rule.fragment.length]!))) return true;
    const start = position + rule.termOffset;
    const remainder = value.slice(0, start) + '\0' + value.slice(start + term.length);
    return remainder.normalize('NFKC').toLowerCase().includes(term);
  });
}

function issuesForText(bytes: Buffer, review: ReviewInput, path: string): Set<string> {
  const issues = new Set<string>();
  if (bytes.length > maxFile) return issues.add('tamanho');
  let value: string;
  try { value = decoder.decode(bytes); } catch { return issues.add('binário'); }
  if (bytes.some(byte => byte === 127 || (byte < 32 && ![9, 10, 13].includes(byte))) ||
      /^(?:%PDF-|SQLite format 3|PGDMP|version https:\/\/git-lfs.github.com\/spec\/v1)/.test(value)) issues.add('binário');
  const examples = credentialLiterals(value);
  if (examples.length && !reviewedExamples.has(digest([path, ...examples].join('\0')))) issues.add('credencial ou URL privada');
  if (containsPrivateTerm(value, review, path)) issues.add('termo privado');
  if (signatures.some(rule => rule.test(value))) issues.add('assinatura sensível');
  for (const match of value.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9][\w.-]*\.[A-Za-z]{2,})\b/g)) {
    if (!/(?:^|\.)example\.(?:org|com|net)$|\.(?:test|invalid|example)$/i.test(match[1]!)) issues.add('contato');
  }
  return issues;
}

// Inspect objects without checking out any historical file or resolving links.
function batch(root: string, ids: string[], kind: string, inspect: (id: string, content: Buffer) => void) {
  if (!ids.length) return;
  const bytes = git(root, ['cat-file', '--batch'], ids.join('\n') + '\n');
  let offset = 0;
  for (const id of ids) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw Error('object header');
    const [actual, type, sizeText] = bytes.toString('ascii', offset, end).split(' ');
    const size = Number(sizeText);
    offset = end + 1;
    if (id !== actual || type !== kind || !Number.isSafeInteger(size) || size < 0 || bytes[offset + size] !== 10) throw Error('object');
    inspect(id, bytes.subarray(offset, offset + size));
    offset += size + 1;
  }
  if (offset !== bytes.length) throw Error('object tail');
}

export function checkPublication(root: string, file: string, ref = 'HEAD', exceptionsFile?: string) {
  root = realpathSync(root);
  const [top, shallow, commonDir] = git(root, ['rev-parse', '--show-toplevel', '--is-shallow-repository', '--path-format=absolute', '--git-common-dir']).toString().trim().split('\n');
  if (!top || !commonDir || realpathSync(top) !== root || shallow !== 'false') throw Error('root');
  const review = loadReview(root, commonDir, file, exceptionsFile);
  const commit = git(root, ['rev-parse', '--verify', '--end-of-options', ref]).toString().trim();
  if (!oid.test(commit)) throw Error('commit');
  let tree = '';
  const failures = new Map<string, number>();
  const fail = (reason: string) => failures.set(reason, (failures.get(reason) ?? 0) + 1);
  const inspect = (bytes: Buffer, path = '') => { for (const reason of issuesForText(bytes, review, path)) fail(reason); };
  const commits = git(root, ['rev-list', commit]).toString().trim().split('\n');
  const reachable = new Set(commits);
  const trees = new Set<string>();
  for (let i = 0; i < commits.length; i += 32) batch(root, commits.slice(i, i + 32), 'commit', (id, raw) => {
    inspect(raw);
    const headers = decoder.decode(raw).split('\n\n', 1)[0]!.split('\n');
    const first = headers[0] ?? '';
    const treeId = first.slice(5);
    if (!first.startsWith('tree ') || !oid.test(treeId)) throw Error('tree');
    if (id === commit) tree = treeId;
    trees.add(treeId);
    for (const header of headers.filter(h => h.startsWith('parent '))) if (!reachable.has(header.slice(7))) throw Error('missing parent');
  });

  if (!tree) throw Error('missing selected commit');
  const blobs = new Map<string, number>();
  const paths = new Map<string, Set<string>>();
  let files = 0;
  for (const rootTree of trees) {
    for (const entry of zeroList(git(root, ['ls-tree', '-rtlz', rootTree]))) {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw Error('tree entry');
      const [mode, type, id, sizeText] = entry.slice(0, tab).trim().split(/\s+/);
      const path = entry.slice(tab + 1);
      if (!id || !mode || !oid.test(id)) throw Error('id');
      inspect(Buffer.from(path));
      if (mode === '040000' && type === 'tree') {
        if (!dirs.has(path)) fail('diretório fora da lista');
        continue;
      }
      if (rootTree === tree) files++;
      if (!allowed.has(path)) fail('arquivo fora da lista');
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) { fail('modo de arquivo'); continue; }
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0 || size > maxFile) { fail('tamanho'); continue; }
      blobs.set(id, size);
      const locations = paths.get(id) ?? new Set<string>();
      locations.add(path);
      paths.set(id, locations);
    }
  }

  let pending: string[] = [], total = 0;
  const flush = () => { batch(root, pending, 'blob', (id, raw) => { for (const path of paths.get(id)!) inspect(raw, path); }); pending = []; total = 0; };
  for (const [id, size] of blobs) {
    if (total + size > 8 * 1024 * 1024 || pending.length >= 2048) flush();
    pending.push(id); total += size;
  }
  flush();

  // Never traverse a symlink or junction, including one replacing a parent directory.
  // Only the reviewed directories are traversed. Git separately identifies untracked additions.
  function visit(dir: string) {
    for (const name of readdirSync(join(root, dir))) {
      if (!dir && name === '.git') continue;
      const path = dir ? dir + '/' + name : name;
      const disk = join(root, path);
      const stat = lstatSync(disk);
      if (stat.isSymbolicLink()) { fail('link no disco'); continue; }
      if (dirs.has(path) && stat.isDirectory()) { visit(path); continue; }
      if (!allowed.has(path)) continue;
      if (!stat.isFile() || !inside(root, realpathSync(disk))) { fail('modo no disco'); continue; }
      if (stat.size > maxFile) fail('tamanho'); else inspect(readFileSync(disk), path);
    }
  }
  visit('');
  if (zeroList(git(root, ['ls-files', '-v', '-z'])).some(line => !line.startsWith('H '))) fail('índice incompleto');
  if (zeroList(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).length) fail('arquivos não rastreados');
  if (git(root, ['diff', '--no-ext-diff', '--name-only', '-z', commit, '--']).length ||
      git(root, ['diff', '--cached', '--no-ext-diff', '--name-only', '-z', commit, '--']).length) fail('árvore divergente');
  return { commit, tree, commits: commits.length, trees: trees.size, files, blobs: blobs.size, failures: Object.fromEntries(failures) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--ref' || !args[1])) throw Error('arguments');
    const result = checkPublication(process.cwd(), process.env.PUBLICATION_TERMS_FILE ?? '', args[1], process.env.PUBLICATION_EXCEPTIONS_FILE);
    console.log(JSON.stringify(result));
    if (Object.keys(result.failures).length) process.exitCode = 1;
  } catch {
    console.error('Verificação incompleta. Confira a raiz Git, o histórico local completo, a referência e o arquivo externo de termos.');
    process.exitCode = 1;
  }
}
