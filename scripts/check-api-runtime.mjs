import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// O runtime Node da função carrega módulos JS emitidos individualmente, sem o resolvedor do Vite.
const root = process.cwd();
const outDir = await mkdtemp(join(root, 'node_modules', '.career-api-runtime-'));
let server;
try {
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([resolve(root, 'api/index.ts')], {
    ...options, rootDir: root, outDir, noEmit: false, allowImportingTsExtensions: false,
  });
  assert.equal(program.emit().emitSkipped, false);
  await writeFile(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));
  delete process.env.OWNER_USER_ID;
  delete process.env.DATABASE_URL;
  Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'production', NODEJS_HELPERS: '0' });
  const { default: handler } = await import(pathToFileURL(join(outDir, 'api/index.js')).href);
  server = createServer(handler);
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vary'), 'Authorization');
  const { error } = await response.json();
  assert.equal(error.code, 'NOT_CONFIGURED');
  assert.ok(error.requestId);
  assert.equal(error.requestId, response.headers.get('x-request-id'));
  console.log('Entrada da API carregada no Node com resposta 503 verificada.');
} finally {
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  await rm(outDir, { recursive: true, force: true });
}
