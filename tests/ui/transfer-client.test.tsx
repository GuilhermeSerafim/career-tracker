// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { createAppRuntime } from '../../src/app/runtime';
import type { AuthPort } from '../../src/lib/auth';
function setup(transport: typeof fetch) {
  const session = { access_token: 'synthetic', user: { id: '11111111-1111-4111-8111-111111111111' } } as Session;
  let reenter = () => {};
  const port: AuthPort = { onAuthStateChange(callback) { callback('INITIAL_SESSION', session); reenter = () => callback('SIGNED_IN', session); return { data: { subscription: { unsubscribe() {} } } }; }, signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) };
  return Object.assign(createAppRuntime(port, transport), { reenter: () => reenter() });
}
it('preserves CSV bytes and refuses to call a received file a saved backup', async () => {
  let init: RequestInit | undefined;
  const runtime = setup(async (_input, options) => { init = options; return new Response('a,b\r\n"=safe",x\r\n', { headers: { 'content-type': 'text/csv' } }); });
  try { const received = await runtime.transfers.export('csv'); expect(received.text).toBe('a,b\r\n"=safe",x\r\n'); expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' }); expect(runtime.transfers.getSnapshot().confirmedAt).toBeNull(); runtime.transfers.confirmSaved(received.receiptId); expect(runtime.transfers.getSnapshot().confirmedAt).not.toBeNull(); } finally { await runtime.dispose(); }
});
it('associates confirmation and errors only with the latest received export', async () => {
  const releases: ((value: Response) => void)[] = [];
  const runtime = setup(async () => new Promise<Response>((resolve) => { releases.push(resolve); }));
  try {
    const older = runtime.transfers.export('csv'); const newer = runtime.transfers.export('json');
    releases[1]!(Response.json({ manifest: {}, entities: [] })); const received = await newer;
    releases[0]!(new Response('old')); await expect(older).rejects.toMatchObject({ status: 0 });
    expect(runtime.transfers.getSnapshot()).toMatchObject({ format: 'json', status: 'received' });
    runtime.transfers.downloadFailed(received.receiptId - 1); runtime.transfers.confirmSaved(received.receiptId - 1);
    expect(runtime.transfers.getSnapshot().confirmedAt).toBeNull();
    runtime.transfers.confirmSaved(received.receiptId); expect(runtime.transfers.getSnapshot().status).toBe('confirmed');
    await runtime.dispose(); runtime.transfers.downloadFailed(received.receiptId); runtime.transfers.confirmSaved(received.receiptId);
    await expect(runtime.transfers.export('csv')).rejects.toMatchObject({ status: 401 });
    expect(runtime.transfers.getSnapshot()).toMatchObject({ status: 'idle', confirmedAt: null });
  } finally { await runtime.dispose(); }
});
it('keeps import replay when expiry occurs between receiving bytes and publishing the parsed result', async () => {
  let reads = 0;
  const runtime = setup(async () => ({ ok: true, body: { getReader: () => ({
    read: async () => { if (reads++ === 0) return { done: false, value: new TextEncoder().encode('{"status":"completed"}') }; queueMicrotask(() => queueMicrotask(() => runtime.auth.expire())); return { done: true }; },
    cancel: async () => {}, releaseLock() {},
  }) } }) as Response);
  try { await expect(runtime.transfers.importUnit({ unit: 'complete', data: {} }, 'test-key')).rejects.toMatchObject({ status: 0 }); expect(runtime.transfers.getSnapshot().pendingImport).not.toBeNull(); }
  finally { await runtime.dispose(); }
});
it.each([401, 403, 503, 413])('never confirms a failed export (%s)', async (status) => {
  const runtime = setup(async () => Response.json({ error: {} }, { status }));
  try { await expect(runtime.transfers.export('json')).rejects.toMatchObject({ status }); expect(runtime.transfers.getSnapshot().confirmedAt).toBeNull(); if (status === 401) expect(runtime.auth.getSnapshot().status).toBe('login'); } finally { await runtime.dispose(); }
});
it('discards late bytes after expiry and rejects excessive uploads before sending', async () => {
  let release!: (response: Response) => void; let calls = 0;
  const runtime = setup(async () => { calls++; return new Promise<Response>((resolve) => { release = resolve; }); });
  try { await expect(runtime.transfers.previewCsv('a'.repeat(4_000_001))).rejects.toMatchObject({ status: 413 }); expect(calls).toBe(0); const pending = runtime.transfers.export('json'); runtime.auth.expire(); release(Response.json({ private: 'synthetic' })); await expect(pending).rejects.toMatchObject({ status: 0 }); expect(runtime.transfers.getSnapshot().receivedAt).toBeNull(); } finally { await runtime.dispose(); }
});
it('retains an uncertain import unit and exact key in tab memory across expiry, then purges at logout', async () => {
  const writes: RequestInit[] = [];
  const runtime = setup(async (_input, init) => { writes.push(init!); return writes.length === 1 ? Response.json({}, { status: 503 }) : Response.json({ status: 'completed' }); });
  const unit = { unit: 'complete' as const, data: { runId: '22222222-2222-4222-8222-222222222222' } };
  try {
    await expect(runtime.transfers.importUnit(unit, 'test-key')).rejects.toMatchObject({ status: 503 });
    runtime.auth.expire(); runtime.reenter(); expect(runtime.transfers.getSnapshot().pendingImport).not.toBeNull();
    await runtime.transfers.retryImport(); expect(writes[1]).toEqual(writes[0]);
    expect(runtime.transfers.getSnapshot().pendingImport).toBeNull();
    await runtime.dispose(); expect(runtime.transfers.getSnapshot().pendingImport).toBeNull();
  } finally { await runtime.dispose(); }
});
