import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const privateRoot = resolve(projectRoot, '.private');
let sandbox: string;
let scriptPath: string;

beforeAll(async () => {
  await mkdir(privateRoot, { recursive: true });
  sandbox = await mkdtemp(join(privateRoot, 'local-db-regression-'));
  await mkdir(join(sandbox, 'scripts'));
  await mkdir(join(sandbox, 'supabase', 'schemas'), { recursive: true });
  scriptPath = join(sandbox, 'scripts', 'local-db.ts');
  await copyFile(join(projectRoot, 'scripts', 'local-db.ts'), scriptPath);
  await writeFile(join(sandbox, 'supabase', 'schemas', '001_probe.sql'), 'SELECT 1;\n');
});

afterAll(async () => {
  if (sandbox && sandbox.startsWith(join(privateRoot, 'local-db-regression-'))) {
    await rm(sandbox, { recursive: true, force: true });
  }
});

it.each(['função', 'CLI'] as const)('propaga a falha de inicialização PostgreSQL pela %s', async (mode) => {
  let receivedStartup = false;
  const endpoint = createServer((socket) => {
    socket.once('data', () => {
      receivedStartup = true;
      socket.end();
    });
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  try {
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('Endpoint de teste indisponível.');
    const args = mode === 'CLI' ? ['--import', 'tsx', scriptPath, 'apply'] : [
      '--import', 'tsx', '--input-type=module', '--eval', `
        import { runLocalDatabase } from ${JSON.stringify(pathToFileURL(scriptPath).href)};
        const deadline = setTimeout(() => { console.log('pending'); process.exitCode = 2; }, 1000);
        runLocalDatabase('apply', process.env.LOCAL_TEST_DATABASE_URL).then(
          () => { clearTimeout(deadline); console.log('resolved'); },
          () => { clearTimeout(deadline); console.log('rejected'); process.exitCode = 1; },
        );
      `,
    ];
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, args, {
        cwd: projectRoot,
        windowsHide: true,
        env: { ...process.env, LOCAL_TEST_DATABASE_URL: `postgresql://tester:local-placeholder@127.0.0.1:${address.port}/career_tracker_test` },
      });
      let stdout = '';
      let stderr = '';
      const deadline = setTimeout(() => { child.kill(); fail(new Error(`O processo não encerrou; inicialização recebida: ${receivedStartup}; resultado: ${stdout}`)); }, 20_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', (error) => { clearTimeout(deadline); fail(error); });
      child.once('close', (code) => { clearTimeout(deadline); done({ code, stdout, stderr }); });
    });
    expect(receivedStartup).toBe(true);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('pending');
    expect(result.stdout + result.stderr).not.toContain('local-placeholder');
    if (mode === 'função') expect(result.stdout).toContain('rejected');
    else expect(result.stderr).toContain('Falha no banco de teste local.');
  } finally {
    await new Promise<void>((done, fail) => endpoint.close((error) => error ? fail(error) : done()));
  }
}, 25_000);
