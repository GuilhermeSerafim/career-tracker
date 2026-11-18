import { spawnSync } from 'node:child_process';

// Build completion precedes the independent 30s preview-readiness deadline.
// No reused preview or stale assets; Playwright owns and closes its server.
const env = { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_e2e_only' };
for (const args of [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['node_modules/vite/bin/vite.js', 'build', '--manifest'],
  ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(JSON.stringify({ phase: args[0], status: result.status, signal: result.signal, error: result.error ? (result.error as NodeJS.ErrnoException).code : null }));
    process.exit(result.status ?? 1);
  }
}
