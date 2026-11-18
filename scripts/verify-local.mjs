import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

// Same immutable PostgreSQL 17.12 image as CI. No existing container is adopted.
const image = 'postgres@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7';
const run = randomUUID();
const containers = [];
const env = { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_e2e_only' };
const npm = process.env.npm_execpath;
let failure;
const cleanupFailures = [];
if (!npm) throw Error('Execute npm run verify:local.');
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw Error('Comando de verificação falhou.');
  return result.stdout?.trim();
}
async function requireFree(port) {
  await new Promise((accept, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : accept()));
  });
}
function removeOwned({ id, name }) {
  const identity = execute('docker', ['inspect', '--format', '{{.Id}} {{.Name}} {{index .Config.Labels "career-tracker-ci"}}', id], { stdio: 'pipe' });
  if (identity !== `${id} /${name} ${run}`) throw Error('Identidade alterada; limpeza recusada.');
  execute('docker', ['rm', '--force', '--volumes', id], { stdio: 'pipe' });
}
try {
  for (const port of [55432, 55434, 4173]) await requireFree(port);
  for (const [port, database, variable] of [[55432, 'career_tracker_test', 'LOCAL_TEST_DATABASE_URL'], [55434, 'career_tracker_restore_test', 'LOCAL_RESTORE_TEST_DATABASE_URL']]) {
    const password = randomBytes(32).toString('hex');
    const name = `career-ci-${run}-${port}`;
    const id = execute('docker', ['run', '--detach', '--name', name, '--label', `career-tracker-ci=${run}`, '--publish', `127.0.0.1:${port}:5432`, '--env', 'POSTGRES_PASSWORD', '--env', `POSTGRES_DB=${database}`, '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', image], { env: { ...env, POSTGRES_PASSWORD: password }, stdio: 'pipe' });
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Identidade de container inválida.');
    containers.push({ id, name });
    env[variable] = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const check = spawnSync('docker', ['exec', id, 'pg_isready', '-U', 'postgres', '-d', database], { stdio: 'ignore' });
      if (check.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw Error('PostgreSQL não ficou pronto.');
  }
  for (const args of [['ci'], ['run', 'typecheck'], ['run', 'lint'], ['test'], ['run', 'db:local:apply'], ['run', 'db:local:check'], ['run', 'test:integration'], ['run', 'build'], ['run', 'build:check'], ['run', 'test:e2e']]) {
    console.log(`Verificando: npm ${args.join(' ')}`);
    execute(process.execPath, [npm, ...args]);
    if (args[0] === 'ci' && !env.PLAYWRIGHT_CHANNEL) execute(process.execPath, ['node_modules/@playwright/test/cli.js', 'install', 'chromium']);
  }
  execute(process.execPath, ['--import', 'tsx', resolve('scripts/audit-local.ts')]);
} catch (error) { failure = error; }
finally {
  for (const { id, name } of containers.reverse()) {
    try {
      removeOwned({ id, name });
    } catch { cleanupFailures.push(Error(`Limpeza não confirmada: ${name}.`)); }
  }
  for (const port of [55432, 55434, 4173]) {
    try { await requireFree(port); } catch { cleanupFailures.push(Error(`Porta ${port} continua ocupada.`)); }
  }
}
if (failure || cleanupFailures.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupFailures], 'Verificação local ou limpeza falhou.');
