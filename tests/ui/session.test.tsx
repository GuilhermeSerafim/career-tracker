// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useSaveIntent } from '../../src/lib/api';
import { AsyncState } from '../../src/components/AsyncState';
import { ConflictDialog } from '../../src/components/ConflictDialog';
import { LoginPage } from '../../src/features/auth/LoginPage';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { createClient, processLock } from '@supabase/supabase-js';
import { GoTrueClient } from '@supabase/auth-js';
import type { Command } from '../../shared/commands';
import { createAuthController, createLogoutSignal, createSdkAuthPort, createSdkSessionStorage } from '../../src/lib/auth';
import type { AuthPort, LogoutChannel, LogoutSignal } from '../../src/lib/auth';
import { ApiError, createApiClient, createSaveIntent } from '../../src/lib/api';
import { createAppQueryClient } from '../../src/app/query';
import { contactAtByteBoundary } from '../helpers/command-budget';
import { commandSchema } from '../../shared/commands';
import { canonicalRequestHash } from '../../server/mutation';

afterEach(cleanup);
const owner = '11111111-1111-4111-8111-111111111111';
const record = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const requestId = '33333333-3333-4333-8333-333333333333';
function session(id = owner, token = 'synthetic-access'): Session {
  return { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer', user: {
    id, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z',
  } };
}
function harness(signal?: LogoutSignal) {
  const listeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>();
  const port: AuthPort = {
    onAuthStateChange(callback) { listeners.add(callback); return { data: { subscription: { unsubscribe: () => { listeners.delete(callback); } } } }; },
    signInWithPassword: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }),
    updateUser: async () => ({ error: null }), signOut: async () => ({ error: null }),
  };
  const cache = createAppQueryClient();
  const auth = createAuthController(port, cache, signal);
  const disconnect = auth.connect();
  const emit = (event: AuthChangeEvent, value: Session | null) => { for (const listener of listeners) listener(event, value); };
  emit('INITIAL_SESSION', session());
  return { auth, cache, emit, port, listeners, disconnect };
}
const draft = { operation: 'update_settings', settings: { id: record, expectedVersion: 1 }, dailyGoal: 4, timezone: 'America/Sao_Paulo' } satisfies Command;
const current = { versions: { [record]: 2 }, fields: { dailyGoal: 7 } };
function response(status: number, body: unknown = { version: 2 }) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function failure(status: number) {
  return response(status, { error: { code: status === 409 ? 'CONFLICT' : 'DATABASE_UNAVAILABLE', message: 'https://private.invalid/?token=secret', requestId,
    ...(status === 409 ? { details: { currentVersion: 2, changedFields: ['daily_goal'] } } : {}) } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('synthetic session/API lifecycle (no hosted Auth proof)', () => {
  it('rejects a schema-valid oversized intention envelope at creation before publishing or sending it', async () => {
    const h = harness(); const requests: RequestInit[] = []; let intent: ReturnType<typeof createSaveIntent> | undefined;
    const oversized = contactAtByteBoundary();
    try {
      expect(commandSchema.safeParse(oversized).success).toBe(true); expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBe(262_134);
      expect(() => canonicalRequestHash({ command: oversized, idempotencyKey: requestId })).toThrow(expect.objectContaining({ status: 413 }));
      expect(() => { intent = createSaveIntent<Command, unknown>({ auth: h.auth, api: createApiClient(h.auth, async (_url, init) => { requests.push(init!); return response(200); }), draft: oversized, readCurrent: async () => current }); }).toThrow(expect.objectContaining({ status: 413 }));
      expect(requests).toHaveLength(0);
    } finally { intent?.dispose(); h.disconnect(); await h.auth.logout(); }
  });

  it.each([262_076, 262_077])('matches the server envelope byte boundary for a %s-byte body', async (bytes) => {
    const h = harness(); const requests: RequestInit[] = []; let intent: ReturnType<typeof createSaveIntent> | undefined;
    const command = contactAtByteBoundary(bytes);
    const envelope = { command, idempotencyKey: requestId };
    try {
      expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBe(bytes + 68);
      const create = () => { intent = createSaveIntent<Command, unknown>({ auth: h.auth, api: createApiClient(h.auth, async (_url, init) => { requests.push(init!); return response(200); }), draft: command, readCurrent: async () => current }); };
      if (bytes === 262_076) {
        expect(() => canonicalRequestHash(envelope)).not.toThrow(); expect(create).not.toThrow(); await intent!.save(); expect(requests).toHaveLength(1);
      } else { expect(() => canonicalRequestHash(envelope)).toThrow(expect.objectContaining({ status: 413 })); expect(create).toThrow(expect.objectContaining({ status: 413 })); expect(requests).toHaveLength(0); }
    } finally { intent?.dispose(); h.disconnect(); await h.auth.logout(); }
  });

  it('keeps the previous editing body, key and current authority after an oversized edit is rejected', async () => {
    const h = harness(); const requests: RequestInit[] = []; const originalKey = '77777777-7777-4777-8777-777777777777';
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(originalKey).mockReturnValue('88888888-8888-4888-8888-888888888888');
    const original: Command = { operation: 'save_contact', target: { id: record, expectedVersion: 1 }, data: { name: null, notes: 'Original editable intention', links: [] } };
    const intent = createSaveIntent<Command, unknown>({ auth: h.auth, api: createApiClient(h.auth, async (_url, init) => { requests.push(init!); return response(200); }), draft: original, readCurrent: async () => ({ versions: { [record]: 1 }, fields: {} }) });
    try {
      await intent.refresh(); const before = intent.getSnapshot();
      expect(() => intent.edit(contactAtByteBoundary(262_134, { id: record, expectedVersion: 1 }))).toThrow(expect.objectContaining({ status: 413 }));
      expect(intent.getSnapshot()).toBe(before); expect(requests).toHaveLength(0);
      await intent.save(); expect(JSON.parse(requests[0]!.body as string)).toEqual(original); expect(new Headers(requests[0]!.headers).get('Idempotency-Key')).toBe(originalKey);
    } finally { intent.dispose(); uuid.mockRestore(); h.disconnect(); await h.auth.logout(); }
  });

  it('keeps an uncertain body/key and authorized comparison atomic after oversized reapply, then separately saves a shorter current intention', async () => {
    const h = harness(); const requests: RequestInit[] = []; let version = 2;
    const original: Command = { operation: 'save_contact', target: { id: record, expectedVersion: 1 }, data: { name: null, notes: 'Original uncertain intention', links: [] } };
    const intent = createSaveIntent<Command, unknown>({ auth: h.auth, api: createApiClient(h.auth, async (_url, init) => { requests.push(init!); return requests.length === 1 ? failure(503) : response(200); }), draft: original, readCurrent: async () => ({ versions: { [record]: version }, fields: {} }) });
    try {
      await intent.save(); await intent.refresh(); const before = intent.getSnapshot();
      expect(() => intent.reapply(contactAtByteBoundary(262_134, { id: record, expectedVersion: 2 }))).toThrow(expect.objectContaining({ status: 413 }));
      expect(intent.getSnapshot()).toBe(before); expect(requests).toHaveLength(1);
      await intent.save(); expect(requests[1]!.body).toBe(requests[0]!.body); expect(new Headers(requests[1]!.headers).get('Idempotency-Key')).toBe(new Headers(requests[0]!.headers).get('Idempotency-Key'));
      version = 3; await intent.refresh();
      expect(() => intent.reapply({ ...original, target: { id: record, expectedVersion: 2 } })).toThrow(expect.objectContaining({ status: 409 }));
      intent.reapply({ ...original, target: { id: record, expectedVersion: 3 }, data: { ...original.data, notes: 'Shorter corrected intention' } }); expect(requests).toHaveLength(2);
      await intent.save(); expect(JSON.parse(requests[2]!.body as string)).toMatchObject({ target: { id: record, expectedVersion: 3 }, data: { notes: 'Shorter corrected intention' } });
      expect(new Headers(requests[2]!.headers).get('Idempotency-Key')).not.toBe(new Headers(requests[0]!.headers).get('Idempotency-Key'));
    } finally { intent.dispose(); h.disconnect(); await h.auth.logout(); }
  });

  it('retains exact input and key after an uncertain 503, confirming only committed success', async () => {
    const h = harness(); const requests: RequestInit[] = []; const pending = deferred<Response>();
    const api = createApiClient(h.auth, async (_url, init) => { requests.push(init!); return requests.length === 1 ? failure(503) : pending.promise; });
    const intent = createSaveIntent<Command, { version: number }>({ auth: h.auth, api, draft, readCurrent: async () => current });
    await intent.save();
    expect(intent.getSnapshot()).toMatchObject({ draft, status: 'unavailable', result: null, error: { requestId } });
    const retry = intent.save();
    expect(intent.getSnapshot().status).toBe('saving');
    expect(intent.getSnapshot().result).toBeNull();
    pending.resolve(response(200)); await retry;
    expect(intent.getSnapshot()).toMatchObject({ status: 'saved', result: { version: 2 } });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toBe(requests[1]!.body);
    const headers = requests.map((item) => new Headers(item.headers));
    expect(headers[0]!.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
    expect(headers[1]!.get('Idempotency-Key')).toBe(headers[0]!.get('Idempotency-Key'));
    expect(headers[1]!.get('Authorization')).toBe('Bearer synthetic-access');
    expect(requests[0]).toMatchObject({ cache: 'no-store', redirect: 'error', credentials: 'omit' });
  });

  it('keeps draft on 401; same-owner reauthentication requires reread before exact retry', async () => {
    const h = harness(); const requests: RequestInit[] = []; let reads = 0;
    const api = createApiClient(h.auth, async (_url, init) => { requests.push(init!); return requests.length === 1 ? failure(401) : response(200); });
    const intent = createSaveIntent({ auth: h.auth, api, draft, readCurrent: async () => { reads++; return current; } });
    await intent.save();
    expect(intent.getSnapshot()).toMatchObject({ status: 'login', draft });
    expect(h.auth.getSnapshot().status).toBe('login');
    h.emit('SIGNED_IN', session(owner, 'new-synthetic-access'));
    await intent.save();
    expect(requests).toHaveLength(1);
    expect(intent.getSnapshot().status).toBe('refresh-required');
    await intent.refresh();
    expect(reads).toBe(1); expect(intent.getSnapshot().current).toEqual(current);
    await intent.save();
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[1]!.headers).get('Idempotency-Key')).toBe(new Headers(requests[0]!.headers).get('Idempotency-Key'));
    expect(new Headers(requests[1]!.headers).get('Authorization')).toBe('Bearer new-synthetic-access');
  });

  it('blocks blind 409 retry and requires a reread plus explicitly versioned reapplication', async () => {
    const h = harness(); const requests: RequestInit[] = [];
    const api = createApiClient(h.auth, async (_url, init) => { requests.push(init!); return requests.length === 1 ? failure(409) : response(200); });
    const intent = createSaveIntent({ auth: h.auth, api, draft, readCurrent: async () => current });
    await intent.save(); await intent.save();
    expect(requests).toHaveLength(1);
    expect(intent.getSnapshot()).toMatchObject({ status: 'conflict', draft, error: { details: { currentVersion: 2 } } });
    expect(() => intent.reapply(draft)).toThrow();
    await intent.refresh();
    expect(() => intent.reapply(draft)).toThrow();
    intent.reapply({ ...draft, settings: { id: record, expectedVersion: 2 }, dailyGoal: 5 });
    expect(requests).toHaveLength(1);
    await intent.save();
    expect(new Headers(requests[1]!.headers).get('Idempotency-Key')).not.toBe(new Headers(requests[0]!.headers).get('Idempotency-Key'));
    expect(JSON.parse(requests[1]!.body as string)).toMatchObject({ dailyGoal: 5, settings: { expectedVersion: 2 } });
  });

  it.each([403, 503])('keeps HTTP %s distinct from session expiration', async (status) => {
    const h = harness(); const api = createApiClient(h.auth, async () => failure(status));
    const intent = createSaveIntent({ auth: h.auth, api, draft, readCurrent: async () => current });
    await intent.save();
    expect(h.auth.getSnapshot().status).toBe('authenticated');
    expect(intent.getSnapshot().status).toBe(status === 403 ? 'forbidden' : 'unavailable');
    expect(intent.getSnapshot().error?.message).not.toContain('private.invalid');
  });

  it.each(['logout', 'different-user'] as const)('purges cache/draft and ignores late save responses after %s', async (action) => {
    const h = harness(); h.cache.setQueryData(['private'], { notes: 'synthetic private text' });
    const pending = deferred<Response>();
    const api = createApiClient(h.auth, async () => pending.promise);
    const intent = createSaveIntent({ auth: h.auth, api, draft, readCurrent: async () => current });
    const saving = intent.save();
    if (action === 'logout') await h.auth.logout(); else h.emit('SIGNED_IN', session('44444444-4444-4444-8444-444444444444'));
    expect(h.cache.getQueryData(['private'])).toBeUndefined();
    expect(intent.getSnapshot()).toMatchObject({ status: 'disposed', draft: null, result: null });
    pending.resolve(response(200)); await saving;
    expect(intent.getSnapshot()).toMatchObject({ status: 'disposed', draft: null, result: null });
  });

  it('shares one SDK subscription and unsubscribes the final consumer', () => {
    const h = harness(); const stop = h.auth.connect();
    expect(h.listeners.size).toBe(1);
    h.disconnect(); expect(h.listeners.size).toBe(1);
    stop(); expect(h.listeners.size).toBe(0);
    h.emit('SIGNED_IN', session('ignored'));
    expect(h.auth.getSnapshot().ownerId).toBe(owner);
  });

  it('keeps current-tab edits behind login on unsolicited SIGNED_OUT and rejects stale INITIAL_SESSION', () => {
    const h = harness(); const api = createApiClient(h.auth, async () => response(200));
    const intent = createSaveIntent({ auth: h.auth, api, draft, readCurrent: async () => current });
    h.emit('SIGNED_OUT', null);
    expect(intent.getSnapshot()).toMatchObject({ status: 'login', draft });
    h.emit('INITIAL_SESSION', session());
    expect(h.auth.getSnapshot().status).toBe('login');
    h.emit('SIGNED_IN', session());
    expect(intent.getSnapshot()).toMatchObject({ status: 'refresh-required', draft });
  });

  it('ignores late Auth callbacks after explicit logout until a new login is requested', async () => {
    const h = harness(); const pending = deferred<{ error: unknown }>(); h.port.signOut = () => pending.promise;
    const logout = h.auth.logout(); h.emit('TOKEN_REFRESHED', session()); h.emit('SIGNED_IN', session());
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'login', session: null, ownerId: null });
    pending.resolve({ error: null }); await logout;
    h.emit('INITIAL_SESSION', session()); expect(h.auth.getSnapshot().session).toBeNull();
    await h.auth.login('synthetic@example.invalid', 'synthetic-password');
    h.emit('SIGNED_IN', session()); expect(h.auth.getSnapshot().status).toBe('authenticated');
  });

  it('does not expire a refreshed session when an older request returns 401', async () => {
    const h = harness(); const pending = deferred<Response>(); const api = createApiClient(h.auth, async () => pending.promise);
    const reading = api.read('/api/v1/settings');
    h.emit('TOKEN_REFRESHED', session(owner, 'refreshed-token'));
    pending.resolve(failure(401)); await expect(reading).rejects.toMatchObject({ status: 401 });
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'authenticated', session: { access_token: 'refreshed-token' } });
  });

  it('rejects late current-version reads after logout', async () => {
    const h = harness(); const pending = deferred<typeof current>();
    const intent = createSaveIntent({ auth: h.auth, api: createApiClient(h.auth, async () => response(200)), draft, readCurrent: () => pending.promise });
    const reading = intent.refresh(); await h.auth.logout(); pending.resolve(current); await reading;
    expect(intent.getSnapshot()).toMatchObject({ status: 'disposed', draft: null, current: null });
  });

  it('does not recreate a canceled query cache from late reads after account switch', async () => {
    const h = harness(); const pending = deferred<Response>(); const api = createApiClient(h.auth, async () => pending.promise);
    const reading = h.cache.fetchQuery({ queryKey: ['private'], queryFn: () => api.read('/api/v1/settings') }).catch(() => undefined);
    h.emit('SIGNED_IN', session('44444444-4444-4444-8444-444444444444'));
    pending.resolve(response(200)); await reading;
    expect(h.cache.getQueryCache().getAll()).toHaveLength(0);
  });

  it('propagates only an explicit logout control signal to other tabs and tears down channels', async () => {
    const channels = new Set<{ receive: (event: MessageEvent) => void }>();
    const messages: unknown[] = []; let opened = 0; let closed = 0;
    const factory = (): LogoutChannel => {
      opened++;
      const item = { receive: (_event: MessageEvent) => { void _event; } }; channels.add(item);
      return { addEventListener: (_type, listener) => { item.receive = listener; }, removeEventListener: () => { item.receive = () => {}; },
        postMessage: (message) => { messages.push(message); for (const other of channels) if (other !== item) other.receive(new MessageEvent('message', { data: message })); },
        close: () => { closed++; channels.delete(item); } };
    };
    const first = harness(createLogoutSignal(factory)); const second = harness(createLogoutSignal(factory));
    second.cache.setQueryData(['private'], { notes: 'synthetic' });
    const pending = deferred<Response>();
    const intent = createSaveIntent({ auth: second.auth, api: createApiClient(second.auth, async () => pending.promise), draft, readCurrent: async () => current });
    const saving = intent.save();
    first.emit('SIGNED_OUT', null); expect(intent.getSnapshot().draft).toEqual(draft);
    await first.auth.logout();
    expect(second.auth.getSnapshot()).toMatchObject({ status: 'login', session: null, ownerId: null });
    expect(intent.getSnapshot()).toMatchObject({ status: 'disposed', draft: null });
    expect(second.cache.getQueryCache().getAll()).toHaveLength(0);
    pending.resolve(response(200)); await saving; expect(intent.getSnapshot().result).toBeNull();
    expect(messages).toEqual(['logout']); expect(opened).toBe(2);
    first.disconnect(); second.disconnect(); expect(closed).toBe(2); expect(channels.size).toBe(0);
  });

  it('normalizes reordered exact command input while refusing changed retries without reconciliation', async () => {
    const h = harness(); const requests: RequestInit[] = [];
    const intent = createSaveIntent({ auth: h.auth, api: createApiClient(h.auth, async (_url, init) => { requests.push(init!); return failure(503); }), draft, readCurrent: async () => current });
    await intent.save();
    intent.edit({ timezone: 'America/Sao_Paulo', dailyGoal: 4, settings: { expectedVersion: 1, id: record.toUpperCase() }, operation: 'update_settings' });
    await intent.save();
    expect(requests[0]!.body).toBe('{"dailyGoal":4,"operation":"update_settings","settings":{"expectedVersion":1,"id":"abcdefab-cdef-4abc-8def-abcdefabcdef"},"timezone":"America/Sao_Paulo"}');
    expect(new Headers(requests[1]!.headers).get('Idempotency-Key')).toBe(new Headers(requests[0]!.headers).get('Idempotency-Key'));
    expect(() => intent.edit({ ...draft, dailyGoal: 8 })).toThrow();
    await intent.refresh();
    expect(() => intent.edit({ ...draft, dailyGoal: 8 })).toThrow();
  });

  it('rejects non-JSON/getter commands before reading properties or submitting', () => {
    const h = harness(); let accessed = false;
    const input = { ...draft, get extra() { accessed = true; return 'secret'; } };
    expect(() => createSaveIntent({ auth: h.auth, api: createApiClient(h.auth), draft: input, readCurrent: async () => current })).toThrow();
    expect(accessed).toBe(false);
  });

  it.each([401, 403])('keeps HTTP %s semantics even when an upstream error body is not JSON', async (status) => {
    const h = harness(); const api = createApiClient(h.auth, async () => new Response('upstream unavailable', { status }));
    await expect(api.read('/api/v1/settings')).rejects.toMatchObject({ status });
    expect(h.auth.getSnapshot().status).toBe(status === 401 ? 'login' : 'authenticated');
  });

  it('does not restore access when a pending password update resolves after expiration', async () => {
    const h = harness(); const pending = deferred<{ error: unknown }>(); h.port.updateUser = () => pending.promise;
    h.emit('PASSWORD_RECOVERY', session()); const updating = h.auth.updatePassword('synthetic-new-password');
    h.emit('SIGNED_OUT', null); pending.resolve({ error: null }); await updating;
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'login', session: null });
  });

  it('finishes an already pending login before SDK signout so it cannot restore persisted access afterward', async () => {
    const h = harness(); const pending = deferred<{ error: unknown }>(); const order: string[] = [];
    h.port.signInWithPassword = async () => { await pending.promise; order.push('login settled'); h.emit('SIGNED_IN', session()); return { error: null }; };
    h.port.signOut = async () => { order.push('signout'); return { error: null }; };
    const login = h.auth.login('synthetic@example.invalid', 'synthetic-password');
    const logout = h.auth.logout();
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'login', session: null });
    pending.resolve({ error: null }); await login; await logout;
    expect(order).toEqual(['login settled', 'signout']);
    expect(h.auth.getSnapshot().session).toBeNull();
  });

  it('retains the original key if explicit reapplication after an uncertain write has exactly the same input', async () => {
    const h = harness(); const requests: RequestInit[] = [];
    const intent = createSaveIntent({ auth: h.auth, api: createApiClient(h.auth, async (_url, init) => { requests.push(init!); return failure(503); }), draft,
      readCurrent: async () => ({ versions: { [record]: 1 }, fields: { dailyGoal: 3 } }) });
    await intent.save(); await intent.refresh(); intent.reapply(draft); await intent.save();
    expect(new Headers(requests[1]!.headers).get('Idempotency-Key')).toBe(new Headers(requests[0]!.headers).get('Idempotency-Key'));
  });

  it('keeps an independent authorized version snapshot if the read adapter later mutates its source object', async () => {
    const h = harness(); const mutable = { versions: { [record]: 2 }, fields: { dailyGoal: 7 } };
    const intent = createSaveIntent({ auth: h.auth, api: createApiClient(h.auth, async () => failure(409)), draft, readCurrent: async () => mutable });
    await intent.save(); await intent.refresh(); mutable.versions[record] = 1;
    expect(() => intent.reapply(draft)).toThrow();
    expect(intent.getSnapshot().current?.versions[record]).toBe(2);
  });

  it('displays a retained editable draft and never announces saved during failure or pending retry', async () => {
    const h = harness(); const pending = deferred<Response>(); let calls = 0;
    const intent = createSaveIntent<Command, { version: number }>({ auth: h.auth, api: createApiClient(h.auth, async () => ++calls === 1 ? failure(503) : pending.promise), draft, readCurrent: async () => current });
    function Form() {
      const state = useSaveIntent(intent);
      return <><label>Meta<input value={state.draft?.operation === 'update_settings' ? state.draft.dailyGoal : ''} onChange={(event) => intent.edit({ ...draft, dailyGoal: Number(event.target.value) })} /></label>
        <button onClick={() => { void intent.save(); }}>Salvar</button><p role="status">{state.status === 'saved' ? 'Salvo' : state.status === 'saving' ? 'Salvando' : state.status === 'unavailable' ? 'Indisponível' : 'Edição'}</p></>;
    }
    render(<Form />); fireEvent.change(screen.getByLabelText('Meta'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' })); await screen.findByText('Indisponível');
    expect(screen.getByLabelText('Meta')).toHaveValue('6'); expect(screen.queryByText('Salvo')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' })); expect(screen.getByRole('status')).toHaveTextContent('Salvando');
    await act(async () => { pending.resolve(response(200)); });
    expect(screen.getByRole('status')).toHaveTextContent('Salvo');
  });
});

describe('accessible reusable session UI', () => {
  it('separates loading, empty, error with retry, and ready without displaying false zero or private errors', () => {
    let retries = 0;
    const view = render(<AsyncState state={{ status: 'loading' }} onRetry={() => { retries++; }}>{(value: number) => <p>Total: {value}</p>}</AsyncState>);
    expect(screen.getByRole('status')).toHaveTextContent(/carregando/i); expect(screen.queryByText('Total: 0')).not.toBeInTheDocument();
    view.rerender(<AsyncState state={{ status: 'empty' }} onRetry={() => { retries++; }}>{(value: number) => <p>Total: {value}</p>}</AsyncState>);
    expect(screen.getByRole('status')).toHaveTextContent(/nenhum/i);
    view.rerender(<AsyncState state={{ status: 'error' }} onRetry={() => { retries++; }}>{(value: number) => <p>Total: {value}</p>}</AsyncState>);
    expect(screen.getByRole('alert')).toHaveTextContent(/não foi possível/i);
    fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i })); expect(retries).toBe(1);
    view.rerender(<AsyncState state={{ status: 'ready', data: 0 }} onRetry={() => { retries++; }}>{(value: number) => <p>Total: {value}</p>}</AsyncState>);
    expect(screen.getByText('Total: 0')).toBeInTheDocument();
  });

  it('shows local/current comparison, requires explicit selection, traps focus and restores it on close', async () => {
    const user = userEvent.setup(); const selected: readonly string[][] = []; let closes = 0;
    const trigger = document.createElement('button'); trigger.textContent = 'Abrir'; document.body.append(trigger); trigger.focus();
    const props = { local: { dailyGoal: 4 }, current: null, onRefresh: async () => ({ status: 'ready' as const, current }), onReapply: (fields: readonly string[]) => { (selected as string[][]).push([...fields]); }, onClose: () => { closes++; } };
    const view = render(<ConflictDialog {...props} />);
    const dialog = screen.getByRole('dialog', { name: /conflito/i });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(within(dialog).getByText('4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reaplicar/i })).toBeDisabled();
    view.rerender(<ConflictDialog {...props} current={current} />);
    expect(screen.getByText('7')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /dailyGoal/i }));
    await user.click(screen.getByRole('button', { name: /reaplicar/i })); expect(selected).toEqual([['dailyGoal']]);
    const close = screen.getByRole('button', { name: /fechar/i }); close.focus(); await user.tab();
    expect(document.activeElement).toBe(within(dialog).getAllByRole('button')[0]);
    await user.keyboard('{Escape}'); expect(closes).toBe(1); view.unmount(); expect(trigger).toHaveFocus(); trigger.remove();
  });

  it('offers login/recovery without signup and clears password after authentication failure', async () => {
    const h = harness(); h.emit('SIGNED_OUT', null);
    h.port.signInWithPassword = async () => ({ error: new Error('https://private.invalid/token') });
    render(<LoginPage auth={h.auth} />);
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'synthetic@example.invalid' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private.invalid');
    expect(screen.getByLabelText('Senha')).toHaveValue('');
    expect(screen.queryByRole('button', { name: /cadastr|criar conta/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /esqueci minha senha/i }));
    fireEvent.click(screen.getByRole('button', { name: /enviar link/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/se o endereço/i);
  });

  it('handles PASSWORD_RECOVERY and updates password outside synchronous SDK callbacks', async () => {
    const h = harness(); const updates: string[] = []; let inCallback = false;
    h.port.updateUser = async ({ password }) => { expect(inCallback).toBe(false); updates.push(password); return { error: null }; };
    render(<LoginPage auth={h.auth} />);
    act(() => { inCallback = true; h.emit('PASSWORD_RECOVERY', session()); inCallback = false; });
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'new-synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Alterar senha' }));
    await waitFor(() => expect(updates).toEqual(['new-synthetic-password']));
    await waitFor(() => expect(h.auth.getSnapshot().status).toBe('authenticated'));
  });

  it('constructs recovery redirect from origin only, excluding callback secrets', async () => {
    const h = harness(); const urls: string[] = [];
    h.port.resetPasswordForEmail = async (_email, options) => { urls.push(options.redirectTo); return { error: null }; };
    window.history.replaceState({}, '', '/?code=synthetic-secret#access_token=synthetic');
    await h.auth.requestRecovery('synthetic@example.invalid');
    expect(urls).toEqual([`${window.location.origin}/recuperar-senha`]);
    window.history.replaceState({}, '', '/');
  });

  it.each(['logout', 'different-user'] as const)('clears login credentials immediately on %s while an old request is still pending', async (action) => {
    const h = harness(); h.emit('SIGNED_OUT', null); const pending = deferred<{ error: unknown }>();
    h.port.signInWithPassword = () => pending.promise;
    render(<LoginPage auth={h.auth} />);
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'synthetic@example.invalid' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    let logout: Promise<void> | undefined;
    act(() => {
      if (action === 'logout') logout = h.auth.logout();
      else h.emit('SIGNED_IN', session('44444444-4444-4444-8444-444444444444'));
    });
    expect(screen.getByLabelText('Senha')).toHaveValue('');
    expect(screen.getByLabelText('E-mail')).toHaveValue('');
    await act(async () => { pending.resolve({ error: null }); await logout; });
    expect(screen.queryByText('Acesso confirmado.')).not.toBeInTheDocument();
  });
});

describe('review regressions: credential identity and authorized rereads', () => {
  const other = '44444444-4444-4444-8444-444444444444';
  it('ignores a late cross-owner USER_UPDATED without destroying the newer owner draft or cache', async () => {
    const h = harness(); const pending = deferred<void>(); h.emit('PASSWORD_RECOVERY', session());
    h.port.updateUser = async () => { await pending.promise; h.emit('USER_UPDATED', session()); return { error: null }; };
    const updating = h.auth.updatePassword('synthetic-password'); h.emit('SIGNED_IN', session(other));
    const intent = createSaveIntent({ auth: h.auth, api: createApiClient(h.auth), draft, readCurrent: async () => current });
    h.cache.setQueryData(['owner-b'], { notes: 'synthetic B' }); pending.resolve(); await updating;
    expect(h.auth.getSnapshot()).toMatchObject({ ownerId: other, status: 'authenticated' });
    expect(intent.getSnapshot().draft).toEqual(draft); expect(h.cache.getQueryData(['owner-b'])).toEqual({ notes: 'synthetic B' });
  });

  it('revokes a previous comparison after denied reread until a new authorized read succeeds', async () => {
    const h = harness(); let reads = 0; let writes = 0;
    const intent = createSaveIntent({ auth: h.auth, api: createApiClient(h.auth, async () => { writes++; return failure(409); }), draft,
      readCurrent: async () => { if (++reads === 2) throw new ApiError(403); return current; } });
    await intent.save(); await intent.refresh(); expect(intent.getSnapshot().current).toEqual(current);
    await intent.refresh();
    expect(intent.getSnapshot()).toMatchObject({ status: 'forbidden', current: null, draft, error: { status: 403 } });
    const changed = { ...draft, dailyGoal: 6, settings: { id: record, expectedVersion: 2 } };
    expect(() => intent.reapply(changed)).toThrow(); await intent.save(); expect(writes).toBe(1);
    await intent.refresh(); intent.reapply(changed); await intent.save(); expect(writes).toBe(2);
  });

  it('retains typed recovery password through same-owner session reannouncements', () => {
    const h = harness(); h.emit('PASSWORD_RECOVERY', session()); render(<LoginPage auth={h.auth} />);
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'synthetic-new-password' } });
    act(() => { h.emit('SIGNED_IN', session()); h.emit('TOKEN_REFRESHED', session(owner, 'renewed-synthetic')); });
    expect(h.auth.getSnapshot().status).toBe('recovery'); expect(screen.getByLabelText('Nova senha')).toHaveValue('synthetic-new-password');
  });

  it.each([503, 403])('surfaces a failed %s reread through the actual controller/dialog pairing and permits explicit retry', async (status) => {
    const h = harness(); let reads = 0;
    const intent = createSaveIntent({ auth: h.auth, api: createApiClient(h.auth, async () => failure(409)), draft,
      readCurrent: async () => { if (++reads === 1) throw new ApiError(status, requestId); return current; } });
    await intent.save();
    function Comparison() { const state = useSaveIntent(intent); return <ConflictDialog local={{ dailyGoal: 4 }} current={state.current} onRefresh={intent.refresh} onReapply={() => {}} onClose={() => {}} />; }
    render(<Comparison />); fireEvent.click(screen.getByRole('button', { name: 'Reler versão atual' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(status === 403 ? /acesso não autorizado/i : /indisponível/i);
    expect(screen.queryByText(/aguardando releitura/i)).not.toBeInTheDocument(); expect(intent.getSnapshot().draft).toEqual(draft);
    expect(screen.getByRole('button', { name: /reaplicar campos/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reler versão atual' }));
    await waitFor(() => expect(intent.getSnapshot().current).toEqual(current));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  function sdkSession(id = owner, loginId = id): Session {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const encode = (data: unknown) => btoa(JSON.stringify(data)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return { ...session(id, `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp, sub: id, session_id: loginId })}.c3ludGhldGlj`), refresh_token: `synthetic-refresh-${loginId}`, expires_at: exp };
  }
  type SdkProbe = { _saveSession(value: Session): Promise<void>; _notifyAllSubscribers(event: AuthChangeEvent, value: Session, broadcast: boolean): Promise<void>; _onVisibilityChanged(initial: boolean): Promise<void> };
  function sdkStorage(values: Map<string, string>, key: string) {
    return createSdkSessionStorage({ getItem: (name) => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value); }, removeItem: (name) => { values.delete(name); } }, key);
  }
  async function sdkRecovery(probe: SdkProbe, storage: ReturnType<typeof sdkStorage>, key: string, value: Session) {
    // Match the installed SDK recovery path: persist, then notify while locked.
    await storage.lock(`lock:${key}`, 5000, async () => {
      await probe._saveSession(value); await probe._notifyAllSubscribers('PASSWORD_RECOVERY', value, false);
    });
  }
  it('purges and broadcasts intentional logout even if synchronous capture fails', async () => {
    let broadcasts = 0; const h = harness({ subscribe: () => () => {}, publish: () => { broadcasts++; } }); h.port.captureLogout = () => { throw Error('synthetic capture failure'); };
    h.cache.setQueryData(['private'], true);
    const result = h.auth.logout();
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'login', session: null, ownerId: null });
    expect(h.cache.getQueryData(['private'])).toBeUndefined(); expect(broadcasts).toBe(1);
    await expect(result).rejects.toThrow('A sessão local foi encerrada'); h.disconnect();
  });

  it('adopts legacy bytes only inside the SDK lock and never treats bookkeeping as recovery proof', async () => {
    const key = 'synthetic-legacy-adoption'; const value = sdkSession(); let held = false; let writes = 0;
    const values = new Map([[key, JSON.stringify(value)]]);
    const storage = createSdkSessionStorage({ getItem: name => values.get(name) ?? null, setItem: (name, text) => { expect(held).toBe(true); writes++; values.set(name, text); }, removeItem: name => { values.delete(name); } }, key,
      async (_name, _timeout, action) => { held = true; try { return await action(); } finally { held = false; } });
    expect(storage.storage.getItem(key)).not.toBeNull(); expect(writes).toBe(0);
    await storage.lock(`lock:${key}`, 5000, async () => {}); expect(writes).toBe(1);
    expect(JSON.parse(values.get(key)!).careerTracker).toMatchObject({ version: 1, origin: 'legacy', blocked: false });
    expect(await storage.establishRecovery(value, { isCurrent: () => true })).toBe(false); expect(writes).toBe(1);
  });

  it.each(['version', 'generation', 'revision', 'blocked'] as const)('preserves invalid %s metadata and fails closed until a verified explicit login', async field => {
    const key = `synthetic-invalid-${field}`; const value = sdkSession();
    const invalid = { ...value, careerTracker: { version: 1, generation: crypto.randomUUID(), revision: crypto.randomUUID(), origin: 'established', blocked: false, [field]: 'invalid' } };
    const raw = JSON.stringify(invalid); const values = new Map([[key, raw]]); const storage = sdkStorage(values, key);
    expect(storage.storage.getItem(key)).toBeNull(); await expect(storage.clearCaptured(value)).rejects.toThrow(); expect(values.get(key)).toBe(raw);
    await storage.lock(`lock:${key}`, 5000, () => storage.promote(value, { isCurrent: () => true }, async () => storage.storage.setItem(key, JSON.stringify(value))));
    expect(storage.storage.getItem(key)).not.toBeNull(); expect(JSON.parse(values.get(key)!).careerTracker).toMatchObject({ origin: 'established', blocked: false });
  });

  it.each(['quarantine', 'new-login', 'refresh'] as const)('rejects queued recovery when %s replaces its captured write revision', async action => {
    const key = `synthetic-recovery-revision-${action}`; const value = sdkSession(owner, 'invalid');
    const old = { ...value, access_token: `${value.access_token}old`, refresh_token: 'old-refresh' };
    const values = new Map<string, string>(); const storage = sdkStorage(values, key);
    const ready = deferred<void>(); const release = deferred<void>();
    const holder = storage.lock(`lock:${key}`, 5000, async () => {
      storage.storage.setItem(key, JSON.stringify(value)); ready.resolve(); await release.promise;
      if (action === 'new-login') { await storage.promote(value, { isCurrent: () => true }, async () => storage.storage.setItem(key, JSON.stringify(value))); storage.observe({ ...value }, 'SIGNED_IN'); }
      if (action === 'refresh') { storage.storage.setItem(key, JSON.stringify(value)); storage.observe({ ...value }, 'TOKEN_REFRESHED'); }
    });
    await ready.promise;
    const quarantine = action === 'quarantine' ? storage.clearCaptured(old) : Promise.resolve();
    const recovery = storage.establishRecovery(value, { isCurrent: () => true }); release.resolve(); await holder; await quarantine;
    expect(await recovery).toBe(false);
    expect(JSON.parse(values.get(key)!).careerTracker.blocked).toBe(action === 'quarantine');
    expect(await storage.establishRecovery({ ...value }, { isCurrent: () => true })).toBe(false);
  });

  it('does not let a previously observed callback adopt a later SDK revision with the same token pair', async () => {
    const key = 'synthetic-stale-identical-pair'; const value = sdkSession(); const values = new Map<string, string>(); const storage = sdkStorage(values, key);
    await storage.lock(`lock:${key}`, 5000, async () => {
      storage.storage.setItem(key, JSON.stringify(value)); expect(storage.observe(value, 'SIGNED_IN')).toBe(true);
      storage.storage.setItem(key, JSON.stringify(value));
    });
    expect(storage.observe(value, 'SIGNED_IN')).toBe(false);
    expect(await storage.establishRecovery(value, { isCurrent: () => true })).toBe(false);
    expect(await storage.establishRecovery({ ...value }, { isCurrent: () => true })).toBe(true);
  });

  it('invalidates recovery queued before logout and accepts only a genuinely fresh recovery write afterward', async () => {
    const key = 'synthetic-recovery-intent'; const old = sdkSession(owner, 'invalid');
    const values = new Map([[key, JSON.stringify(old)]]); const storage = sdkStorage(values, key);
    const transport: typeof fetch = async url => String(url).includes('/logout') ? new Response(null, { status: 204 }) : response(200, { user: old.user });
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: storage.storage, lock: storage.lock, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage }), createAppQueryClient(), { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect(); const probe = main.auth as unknown as SdkProbe; let logout: Promise<void> | undefined;
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().status).toBe('authenticated'));
      await storage.lock(`lock:${key}`, 5000, async () => {
        const recovery = { ...old }; await probe._saveSession(recovery); await probe._notifyAllSubscribers('PASSWORD_RECOVERY', recovery, false);
        logout = auth.logout(); expect(auth.getSnapshot().status).toBe('login');
      });
      await logout; expect((await main.auth.getSession()).data.session).toBeNull();
      await probe._notifyAllSubscribers('PASSWORD_RECOVERY', { ...old }, false); expect(auth.getSnapshot().status).toBe('login');
      await sdkRecovery(probe, storage, key, { ...old }); await waitFor(() => expect(auth.getSnapshot().status).toBe('recovery'));
      expect((await main.auth.getSession()).data.session?.access_token).toBe(old.access_token);
    } finally { stop(); await main.auth.dispose(); }
  });

  it.each(['automatic-network', 'automatic-flow-network', 'automatic-lock', 'automatic-commit', 'initialized-network'] as const)('supersedes PKCE recovery begun before incoming logout and preserves a fresh recovery: %s', async phase => {
    const key = `synthetic-pending-pkce-${phase}`; const old = sdkSession(); const recovered = sdkSession(owner, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const flow = 'synthetic-original-flow'; const flowKey = `${key}-flow-${flow}-code-verifier`; const indexKey = `${key}-flows-code-verifier`;
    const url = window.location.href; window.history.replaceState({}, '', phase === 'initialized-network' ? '/' : `/recuperar-senha?code=synthetic-code${phase === 'automatic-flow-network' ? `&sb_flow_id=${flow}` : ''}`);
    const values = new Map([[`${key}-code-verifier`, JSON.stringify('synthetic-verifier/recovery')]]);
    if (phase === 'automatic-flow-network') { values.set(flowKey, JSON.stringify('synthetic-verifier/recovery')); values.set(indexKey, JSON.stringify([flow])); }
    if (phase === 'initialized-network') values.set(key, JSON.stringify(old));
    let incoming = () => {}; let commitLogout = false;
    const storage = createSdkSessionStorage({ getItem: name => values.get(name) ?? null, setItem: (name, value) => {
      values.set(name, value);
      if (phase === 'automatic-commit' && name === key && !commitLogout) { commitLogout = true; queueMicrotask(() => incoming()); }
    }, removeItem: name => { values.delete(name); } }, key);
    const heldResponse = deferred<Response>(); const requested = deferred<void>();
    const heldLock = deferred<void>(); const lockEntered = deferred<void>();
    const holder = phase === 'automatic-lock' ? processLock(`lock:${key}`, 5000, async () => { lockEntered.resolve(); await heldLock.promise; }) : Promise.resolve();
    if (phase === 'automatic-lock') await lockEntered.promise;
    let exchanges = 0;
    const transport: typeof fetch = async input => {
      if (String(input).includes('/token?grant_type=pkce')) { exchanges++; requested.resolve(); return exchanges === 1 && !['automatic-lock', 'automatic-commit'].includes(phase) ? heldResponse.promise : response(200, recovered); }
      if (String(input).includes('/logout')) return new Response(null, { status: 204 });
      return response(200, { user: old.user });
    };
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: storage.storage, lock: storage.lock, flowType: 'pkce', autoRefreshToken: false, detectSessionInUrl: phase !== 'initialized-network' }, global: { fetch: transport } });
    const cache = createAppQueryClient();
    const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage }), cache, { subscribe: listener => { incoming = listener; return () => {}; }, publish() {} });
    const stop = auth.connect(); let explicit: ReturnType<typeof main.auth.exchangeCodeForSession> | undefined;
    try {
      if (phase === 'initialized-network') { await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().status).toBe('authenticated')); explicit = main.auth.exchangeCodeForSession('synthetic-code'); }
      if (phase === 'automatic-commit') await main.auth.initialize();
      else { if (phase !== 'automatic-lock') await requested.promise; incoming(); }
      expect(auth.getSnapshot()).toMatchObject({ status: 'login', session: null, ownerId: null });
      const freshVerifier = JSON.stringify('synthetic-fresh-verifier/recovery'); values.set(`${key}-code-verifier`, freshVerifier);
      if (phase === 'automatic-flow-network') { values.set(flowKey, freshVerifier); values.set(indexKey, JSON.stringify([flow, 'synthetic-newer-flow'])); }
      heldLock.resolve(); await holder; heldResponse.resolve(response(200, recovered));
      await main.auth.initialize(); await explicit?.catch(() => undefined);
      expect((await main.auth.getSession()).data.session === null).toBe(true); expect(auth.getSnapshot().status).toBe('login');
      expect(exchanges).toBe(phase === 'automatic-lock' ? 0 : 1);
      expect(values.get(`${key}-code-verifier`)).toBe(freshVerifier);
      if (phase === 'automatic-flow-network') { expect(values.get(flowKey)).toBe(freshVerifier); expect(JSON.parse(values.get(indexKey)!)).toEqual([flow, 'synthetic-newer-flow']); }
      window.history.replaceState({}, '', '/');
      const reopenedStorage = sdkStorage(values, key);
      const reopened = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: reopenedStorage.storage, lock: reopenedStorage.lock, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
      try { await reopened.auth.initialize(); expect((await reopened.auth.getSession()).data.session).toBeNull(); } finally { await reopened.auth.dispose(); }
      expect((await main.auth.exchangeCodeForSession('synthetic-fresh-code')).error).toBeNull();
      await waitFor(() => expect(auth.getSnapshot().status).toBe('recovery'));
      expect((await main.auth.getSession()).data.session?.access_token).toBe(recovered.access_token);
    } finally { heldLock.resolve(); heldResponse.resolve(response(200, recovered)); await holder; await explicit?.catch(() => undefined); stop(); await main.auth.dispose(); cache.clear(); window.history.replaceState({}, '', url); }
  });

  it('preserves a newer explicit login that wins the lock before superseded automatic PKCE initialization', async () => {
    const key = 'synthetic-pkce-newer-winner'; const newer = sdkSession(owner, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const values = new Map([[`${key}-code-verifier`, JSON.stringify('synthetic-newer-verifier/recovery')]]);
    const queued = deferred<void>(); let watch = false; let pkceCalls = 0;
    const base = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } };
    const newerStorage = createSdkSessionStorage(base, key, (name, timeout, action) => { if (watch) queued.resolve(); return processLock(name, timeout, action); });
    const transport: typeof fetch = async input => {
      if (String(input).includes('grant_type=pkce')) { pkceCalls++; return response(200, sdkSession()); }
      return response(200, String(input).includes('/token') ? newer : { user: newer.user });
    };
    const options = (storage: typeof newerStorage, automatic: boolean) => ({ auth: { storageKey: key, storage: storage.storage, lock: storage.lock, flowType: 'pkce' as const, autoRefreshToken: false, detectSessionInUrl: automatic }, global: { fetch: transport } });
    const newerSdk = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', options(newerStorage, false)); await newerSdk.auth.initialize();
    const newerPort = createSdkAuthPort(newerSdk.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: newerStorage });
    const entered = deferred<void>(); const release = deferred<void>();
    const holder = processLock(`lock:${key}`, 5000, async () => { entered.resolve(); await release.promise; }); await entered.promise; watch = true;
    const login = newerPort.signInWithPassword({ email: 'synthetic@example.invalid', password: 'synthetic' }, { isCurrent: () => true }); await queued.promise;
    const url = window.location.href; window.history.replaceState({}, '', '/recuperar-senha?code=synthetic-stale-code');
    const storage = sdkStorage(values, key); const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', options(storage, true));
    let incoming = () => {}; const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage }), createAppQueryClient(), { subscribe: listener => { incoming = listener; return () => {}; }, publish() {} }); const stop = auth.connect();
    try {
      incoming(); expect(auth.getSnapshot().status).toBe('login'); release.resolve(); await holder; expect((await login).error).toBeNull(); await main.auth.initialize();
      await waitFor(() => expect(auth.getSnapshot().status).toBe('authenticated'));
      expect((await main.auth.getSession()).data.session?.access_token).toBe(newer.access_token); expect(pkceCalls).toBe(0);
      expect(values.get(`${key}-code-verifier`)).toBe(JSON.stringify('synthetic-newer-verifier/recovery'));
    } finally { release.resolve(); await holder; await login; stop(); await main.auth.dispose(); await newerSdk.auth.dispose(); window.history.replaceState({}, '', url); }
  });

  it('preserves fresh PKCE first-save ownership while old recovery cleanup waits before notification', async () => {
    const key = 'synthetic-pkce-first-save-generation'; const old = sdkSession(owner, 'invalid');
    const newer = { ...old, refresh_token: 'synthetic-fresh-recovery' }; const values = new Map<string, string>();
    const storage = sdkStorage(values, key); const freshStorage = sdkStorage(values, key); let exchanges = 0;
    const transport: typeof fetch = async input => String(input).includes('/token') ? response(200, ++exchanges === 1 ? old : newer) : new Response(null, { status: 204 });
    const client = (adapter: typeof storage) => createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: adapter.storage, lock: adapter.lock, flowType: 'pkce', autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const main = client(storage); const fresh = client(freshStorage); const entered = deferred<void>(); const release = deferred<void>();
    const blocker = fresh.auth.onAuthStateChange(async event => { if (event === 'PASSWORD_RECOVERY') { entered.resolve(); await release.promise; } });
    let exchanging: ReturnType<typeof fresh.auth.exchangeCodeForSession> | undefined;
    try {
      await main.auth.initialize(); await fresh.auth.initialize(); values.set(`${key}-code-verifier`, JSON.stringify('synthetic-old/recovery'));
      expect((await main.auth.exchangeCodeForSession('synthetic-old-code')).error).toBeNull();
      const oldGeneration = JSON.parse(values.get(key)!).careerTracker.generation;
      const port = createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage });
      const captured = port.captureLogout!(null);
      values.set(`${key}-code-verifier`, JSON.stringify('synthetic-fresh/recovery'));
      exchanging = fresh.auth.exchangeCodeForSession('synthetic-fresh-code'); await entered.promise;
      // The SDK wrote the fresh response, but no recovery promotion has run.
      expect(JSON.parse(values.get(key)!).careerTracker.generation !== oldGeneration).toBe(true);
      const cleanup = port.signOut(captured); release.resolve(); expect((await exchanging).error).toBeNull(); expect((await cleanup).error).toBeNull();
      expect((await fresh.auth.getSession()).data.session?.refresh_token).toBe(newer.refresh_token);
      const reopened = client(sdkStorage(values, key)); try { await reopened.auth.initialize(); expect((await reopened.auth.getSession()).data.session?.refresh_token).toBe(newer.refresh_token); } finally { await reopened.auth.dispose(); }
    } finally { release.resolve(); await exchanging; blocker.data.subscription.unsubscribe(); await main.auth.dispose(); await fresh.auth.dispose(); }
  });

  it('serializes a genuine same-tab reset after stale PKCE and preserves its verifier, index and fresh recovery', async () => {
    const key = 'synthetic-pkce-concurrent-reset'; const old = sdkSession(); const recovered = sdkSession(owner, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    const values = new Map([[key, JSON.stringify(old)], [`${key}-code-verifier`, JSON.stringify('synthetic-old/recovery')]]); const storage = sdkStorage(values, key);
    const entered = deferred<void>(); const held = deferred<Response>(); let exchanges = 0; let resets = 0;
    const transport: typeof fetch = async input => {
      if (String(input).includes('/token?grant_type=pkce')) { if (++exchanges === 1) { entered.resolve(); return held.promise; } return response(200, recovered); }
      if (String(input).includes('/recover')) { resets++; return response(200, {}); }
      return new Response(null, { status: 204 });
    };
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: storage.storage, lock: storage.lock, flowType: 'pkce', autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const port = createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage });
    const auth = createAuthController(port, createAppQueryClient(), { subscribe: () => () => {}, publish() {} }); const stop = auth.connect();
    const resetMethod = vi.spyOn(main.auth, 'resetPasswordForEmail'); let exchange: Promise<unknown> | undefined; let logout: Promise<void> | undefined; let reset: ReturnType<typeof port.resetPasswordForEmail> | undefined;
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().status).toBe('authenticated'));
      exchange = main.auth.exchangeCodeForSession('synthetic-old-code').catch(() => undefined); await entered.promise;
      logout = auth.logout(); reset = port.resetPasswordForEmail('synthetic@example.invalid', { redirectTo: 'https://synthetic.invalid/recuperar-senha' });
      expect(resetMethod).not.toHaveBeenCalled(); // No unlocked verifier writes inside the old SDK operation.
      held.resolve(response(200, recovered)); await exchange; await logout; expect((await reset).error).toBeNull(); expect(resets).toBe(1);
      expect(typeof JSON.parse(values.get(`${key}-code-verifier`)!)).toBe('string');
      const flows = JSON.parse(values.get(`${key}-flows-code-verifier`)!); expect(flows).toHaveLength(1);
      expect(values.get(`${key}-flow-${flows[0]}-code-verifier`)).toBe(values.get(`${key}-code-verifier`));
      expect((await main.auth.exchangeCodeForSession('synthetic-new-code', { flowId: flows[0] })).error).toBeNull();
      await waitFor(() => expect(auth.getSnapshot().status).toBe('recovery'));
      expect((await main.auth.getSession()).data.session?.access_token).toBe(recovered.access_token);
    } finally { held.resolve(response(200, recovered)); await exchange; await logout; await reset; resetMethod.mockRestore(); stop(); await main.auth.dispose(); }
  });

  it.each(['first-save', 'repeated-save', 'establishment', 'published'] as const)('keeps one recovery ownership through logout at the %s handoff and a fresh controller reload', async phase => {
    const key = `synthetic-recovery-handoff-${phase}`; const url = window.location.href;
    window.history.replaceState({}, '', '/recuperar-senha?code=synthetic-handoff');
    const values = new Map([[`${key}-code-verifier`, JSON.stringify('synthetic-old/recovery')]]); const generations: string[] = [];
    const delivered = deferred<void>(); const cleaned = deferred<void>(); let incoming = () => {}; let deliveries = 0; let cleanups = 0;
    const cache = createAppQueryClient();
    const deliver = () => { deliveries++; cache.setQueryData(['handoff-draft'], true); incoming(); delivered.resolve(); };
    const targetWrite = phase === 'first-save' ? 1 : phase === 'repeated-save' ? 2 : phase === 'establishment' ? 3 : 0;
    const base = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => {
      values.set(name, value);
      if (name === key) { generations.push(JSON.parse(value).careerTracker.generation); if (generations.length === targetWrite) queueMicrotask(deliver); }
    }, removeItem: (name: string) => { values.delete(name); } };
    const storage = createSdkSessionStorage(base, key); let exchanges = 0;
    const transport: typeof fetch = async input => String(input).includes('/token') ? response(200, sdkSession(owner, ++exchanges === 1 ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')) : new Response(null, { status: 204 });
    const options = (adapter: typeof storage, automatic: boolean) => ({ auth: { storageKey: key, storage: adapter.storage, lock: adapter.lock, flowType: 'pkce' as const, autoRefreshToken: false, detectSessionInUrl: automatic }, global: { fetch: transport } });
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', options(storage, true));
    const port = createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage });
    const originalSignOut = port.signOut;
    port.signOut = async context => { try { return await originalSignOut(context); } finally { cleanups++; cleaned.resolve(); } };
    const auth = createAuthController(port, cache, { subscribe: listener => { incoming = listener; return () => {}; }, publish() {} }); const stop = auth.connect();
    try {
      await main.auth.initialize();
      if (phase === 'published') { await waitFor(() => expect(auth.getSnapshot().status).toBe('recovery')); deliver(); }
      await delivered.promise; await cleaned.promise;
      expect(deliveries).toBe(1); expect(cleanups).toBe(1); // Removing a write must not silently skip the logout seam.
      expect(generations).toHaveLength(targetWrite || 3);
      expect(auth.getSnapshot()).toMatchObject({ status: 'login', session: null, ownerId: null }); expect(cache.getQueryData(['handoff-draft'])).toBeUndefined();
      expect((await main.auth.getSession()).data.session === null).toBe(true);
      window.history.replaceState({}, '', '/');
      const reopenedStorage = createSdkSessionStorage(base, key); const reopened = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', options(reopenedStorage, false));
      const reopenedCache = createAppQueryClient(); const reopenedAuth = createAuthController(createSdkAuthPort(reopened.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: reopenedStorage }), reopenedCache, { subscribe: () => () => {}, publish() {} }); const disconnect = reopenedAuth.connect();
      try {
        await reopened.auth.initialize(); await waitFor(() => expect(reopenedAuth.getSnapshot().status).not.toBe('loading'));
        expect(reopenedAuth.getSnapshot().status).toBe('login'); expect((await reopened.auth.getSession()).data.session === null).toBe(true);
      } finally { disconnect(); await reopened.auth.dispose(); reopenedCache.clear(); }
      expect(new Set(generations).size).toBe(1);
      values.set(`${key}-code-verifier`, JSON.stringify('synthetic-new/recovery'));
      expect((await main.auth.exchangeCodeForSession('synthetic-new-handoff')).error).toBeNull(); await waitFor(() => expect(auth.getSnapshot().status).toBe('recovery'));
      expect(JSON.parse(values.get(key)!).careerTracker.generation).not.toBe(generations[0]);
    } finally { stop(); await main.auth.dispose(); cache.clear(); window.history.replaceState({}, '', url); }
  });
  it('uses actual SDK isolation so a superseded remote password update cannot overwrite B credentials/draft/cache', async () => {
    const key = 'synthetic-main-session'; const values = new Map([[key, JSON.stringify(sdkSession())]]);
    const pending = deferred<Response>(); const started = deferred<void>(); const methods: string[] = [];
    const transport: typeof fetch = async (url, init) => {
      expect(new URL(String(url)).origin).toBe('https://sdk-synthetic.invalid'); methods.push(init?.method ?? 'GET');
      if (init?.method === 'PUT') { started.resolve(); return pending.promise; }
      return response(200, { user: sdkSession().user });
    };
    const sessionStorage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: sessionStorage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const port = createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage });
    const cache = createAppQueryClient(); const auth = createAuthController(port, cache, { subscribe: () => () => {}, publish() {} }); const stop = auth.connect();
    const probe = main.auth as unknown as SdkProbe;
    const disposal = vi.spyOn(GoTrueClient.prototype, 'dispose');
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().ownerId).toBe(owner));
      await sdkRecovery(probe, sessionStorage, key, sdkSession());
      await waitFor(() => expect(auth.getSnapshot().status).toBe('recovery'));
      const updating = auth.updatePassword('synthetic-password').catch(() => undefined); await started.promise;
      const ownerB = sdkSession(other); values.set(key, JSON.stringify(ownerB)); await probe._notifyAllSubscribers('SIGNED_IN', ownerB, false);
      const intent = createSaveIntent({ auth, api: createApiClient(auth), draft, readCurrent: async () => current }); cache.setQueryData(['owner-b'], { notes: 'synthetic B' });
      pending.resolve(response(200, { user: sdkSession().user })); await updating;
      expect(auth.getSnapshot()).toMatchObject({ ownerId: other, status: 'authenticated' });
      expect(JSON.parse(values.get(key)!)).toEqual(ownerB);
      expect((await main.auth.getSession()).data.session?.user.id).toBe(other);
      expect(intent.getSnapshot().draft).toEqual(draft); expect(cache.getQueryData(['owner-b'])).toEqual({ notes: 'synthetic B' });
      expect(methods.filter((method) => method === 'PUT')).toHaveLength(1);
      expect(disposal).toHaveBeenCalledTimes(1); // Operation client disposed; main remains alive until finally.
      const disposed = disposal.mock.contexts[0] as unknown as { persistSession: boolean; autoRefreshToken: boolean; storageKey: string; visibilityChangedCallback: unknown; autoRefreshTicker: unknown; broadcastChannel: unknown; stateChangeEmitters: Map<unknown, unknown> };
      expect(disposed.persistSession).toBe(false); expect(disposed.autoRefreshToken).toBe(false); expect(disposed.storageKey).not.toBe(key);
      expect(disposed.visibilityChangedCallback).toBeNull(); expect(disposed.autoRefreshTicker).toBeNull(); expect(disposed.broadcastChannel).toBeNull(); expect(disposed.stateChangeEmitters.size).toBe(0);
    } finally { stop(); await main.auth.dispose(); disposal.mockRestore(); }
  });

  it.each(['before-drain', 'during-revocation'] as const)('binds old logout to its captured credentials when a newer same-owner login wins %s', async (when) => {
    const key = 'synthetic-captured-logout'; const old = sdkSession();
    const newer = sdkSession(owner, '22222222-2222-4222-8222-222222222222');
    const values = new Map([[key, JSON.stringify(old)]]);
    const updating = deferred<Response>(); const updateStarted = deferred<void>();
    const revoking = deferred<Response>(); const revokeStarted = deferred<void>();
    const requests: { token: string | null; scope: string | null }[] = [];
    const transport: typeof fetch = async (url, init) => {
      if (init?.method === 'PUT') { updateStarted.resolve(); return updating.promise; }
      if (String(url).includes('/logout')) { requests.push({ token: new Headers(init?.headers).get('authorization'), scope: new URL(String(url)).searchParams.get('scope') }); revokeStarted.resolve(); return revoking.promise; }
      return response(200, { user: old.user });
    };
    const storage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: storage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage }), createAppQueryClient(), { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect(); const probe = main.auth as unknown as SdkProbe;
    let update: Promise<void> | undefined; let logout: Promise<void> | undefined;
    try {
      await main.auth.initialize(); await sdkRecovery(probe, storage, key, old);
      await waitFor(() => expect(auth.getSnapshot().status).toBe('recovery'));
      update = auth.updatePassword('synthetic-password').catch(() => undefined); await updateStarted.promise;
      logout = auth.logout();
      const promote = async () => { values.set(key, JSON.stringify(newer)); await probe._notifyAllSubscribers('SIGNED_IN', newer, false); };
      if (when === 'before-drain') await promote();
      updating.resolve(response(200, { user: old.user })); await update; await revokeStarted.promise;
      if (when === 'during-revocation') await promote();
      revoking.resolve(new Response(null, { status: 204 })); await logout;
      expect(JSON.parse(values.get(key)!)).toEqual(newer);
      expect(auth.getSnapshot()).toMatchObject({ status: 'authenticated', ownerId: owner, session: newer });
      expect(requests).toEqual([{ token: `Bearer ${old.access_token}`, scope: 'local' }]);
    } finally { updating.resolve(response(200, { user: old.user })); revoking.resolve(new Response(null, { status: 204 })); await update; await logout; stop(); await main.auth.dispose(); }
  });

  it.each(['local', 'incoming'] as const)('starts a second intentional logout for B while A is pending and preserves C: %s', async kind => {
    const key = `synthetic-second-logout-${kind}`; const a = sdkSession();
    const b = sdkSession(owner, '22222222-2222-4222-8222-222222222222');
    const c = sdkSession(owner, '33333333-3333-4333-8333-333333333333');
    const values = new Map([[key, JSON.stringify(a)]]); const storage = sdkStorage(values, key);
    const heldA = deferred<Response>(); const heldB = deferred<Response>(); const startedA = deferred<void>(); const startedB = deferred<void>();
    let calls = 0; let incoming = () => {}; let broadcasts = 0;
    const transport: typeof fetch = async url => {
      if (String(url).includes('/logout')) { calls++; if (calls === 1) { startedA.resolve(); return heldA.promise; } startedB.resolve(); return heldB.promise; }
      return response(200, { user: a.user });
    };
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: storage.storage, lock: storage.lock, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const cache = createAppQueryClient(); const port = createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage });
    const auth = createAuthController(port, cache, { subscribe: listener => { incoming = listener; return () => {}; }, publish: () => { broadcasts++; } });
    const stop = auth.connect(); let first: Promise<void> | undefined; let second: Promise<void> | undefined;
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().status).toBe('authenticated'));
      first = auth.logout(); await startedA.promise;
      await main.auth.setSession(b); await waitFor(() => expect(auth.getSnapshot().session?.access_token).toBe(b.access_token));
      cache.setQueryData(['private-b'], { draft: true }); const generation = auth.getSnapshot().generation;
      if (kind === 'local') second = auth.logout(); else incoming();
      expect(auth.getSnapshot()).toMatchObject({ status: 'login', session: null, ownerId: null });
      expect(auth.getSnapshot().generation).toBeGreaterThan(generation); expect(cache.getQueryData(['private-b'])).toBeUndefined();
      await startedB.promise; expect((await main.auth.getSession()).data.session).toBeNull();
      await main.auth.setSession(c); cache.setQueryData(['private-c'], { draft: true });
      heldA.resolve(new Response(null, { status: 204 })); heldB.resolve(new Response(null, { status: 204 })); await first; await second;
      expect(auth.getSnapshot().session?.access_token).toBe(c.access_token); expect(cache.getQueryData(['private-c'])).toEqual({ draft: true });
      expect((await main.auth.getSession()).data.session?.access_token).toBe(c.access_token);
      expect(calls).toBe(2); expect(broadcasts).toBe(kind === 'local' ? 2 : 1);
    } finally { heldA.resolve(new Response(null, { status: 204 })); heldB.resolve(new Response(null, { status: 204 })); await first; await second; stop(); await main.auth.dispose(); cache.clear(); }
  });

  it.each(['missing', 'malformed'] as const)('keeps indeterminate rotated storage logged out across a fresh SDK/controller: %s', async kind => {
    const key = `synthetic-rotated-reload-${kind}`;
    const make = (nonce: number) => {
      const value = sdkSession(); const payload = { sub: owner, exp: value.expires_at, nonce, ...(kind === 'malformed' ? { session_id: 'invalid' } : {}) };
      return { ...value, access_token: `e30.${btoa(JSON.stringify(payload)).replace(/=/g, '')}.c3ludGhldGlj`, refresh_token: `synthetic-${nonce}` };
    };
    const old = make(1); const rotated = make(2); const values = new Map([[key, JSON.stringify(rotated)]]); const storage = sdkStorage(values, key);
    let remoteCalls = 0;
    const transport: typeof fetch = async () => { remoteCalls++; return new Response(null, { status: 204 }); };
    const main = { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), resetPasswordForEmail: async () => ({ error: null }), setSession: async () => ({ error: null }) };
    const port = createSdkAuthPort(main, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage });
    expect((await port.signOut({ session: old })).error).toBeNull();
    const reopenedStorage = sdkStorage(values, key);
    const reopened = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: reopenedStorage.storage, lock: reopenedStorage.lock, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const cache = createAppQueryClient(); const auth = createAuthController(createSdkAuthPort(reopened.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: reopenedStorage }), cache, { subscribe: () => () => {}, publish() {} }); const stop = auth.connect();
    try {
      await reopened.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().status).not.toBe('loading'));
      expect((await reopened.auth.getSession()).data.session).toBeNull(); expect(auth.getSnapshot().status).toBe('login');
      expect(remoteCalls).toBe(1);
    } finally { stop(); await reopened.auth.dispose(); cache.clear(); }
  });

  it.each(['missing', 'malformed'] as const)('preserves an explicit newer login that wins the SDK lock without a usable JWT identity: %s', async kind => {
    const key = `synthetic-newer-unknown-${kind}`;
    const make = (nonce: number) => {
      const original = sdkSession(); const payload = { sub: owner, exp: original.expires_at, nonce, ...(kind === 'malformed' ? { session_id: 'invalid' } : {}) };
      return { ...original, access_token: `e30.${btoa(JSON.stringify(payload)).replace(/=/g, '')}.c3ludGhldGlj`, refresh_token: `synthetic-${nonce}` };
    };
    const old = make(1); const newer = make(2); const values = new Map([[key, JSON.stringify(old)]]); const storage = sdkStorage(values, key);
    const queued = deferred<void>(); let watch = false;
    const otherStorage = createSdkSessionStorage({ getItem: name => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value); }, removeItem: name => { values.delete(name); } }, key,
      (name, timeout, action) => { if (watch) queued.resolve(); return processLock(name, timeout, action); });
    const transport: typeof fetch = async url => String(url).includes('/logout') ? new Response(null, { status: 204 }) : response(200, String(url).includes('/token') ? newer : { user: newer.user });
    const client = (adapter: typeof storage) => createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: adapter.storage, lock: adapter.lock, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const main = client(storage); const other = client(otherStorage);
    const port = (sdk: typeof main, adapter: typeof storage) => createSdkAuthPort(sdk.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: adapter });
    const auth = createAuthController(port(main, storage), createAppQueryClient(), { subscribe: () => () => {}, publish() {} }); const stop = auth.connect();
    const entered = deferred<void>(); const held = deferred<void>(); let holder: Promise<void> | undefined;
    try {
      await main.auth.initialize(); await other.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().status).toBe('authenticated'));
      holder = storage.lock(`lock:${key}`, 5000, async () => { entered.resolve(); await held.promise; }); await entered.promise; watch = true;
      const login = port(other, otherStorage).signInWithPassword({ email: 'synthetic@example.invalid', password: 'synthetic' }, { isCurrent: () => true }); await queued.promise;
      const logout = auth.logout(); held.resolve(); await holder; expect((await login).error).toBeNull(); await logout;
      const persisted = (await other.auth.getSession()).data.session!; expect(persisted.access_token).toBe(newer.access_token);
      await (main.auth as unknown as SdkProbe)._notifyAllSubscribers('SIGNED_IN', persisted, false);
      expect(auth.getSnapshot().status).toBe('authenticated'); expect(auth.getSnapshot().session?.access_token).toBe(newer.access_token);
      // A fresh wrapper proves ownership survives an application reload.
      const reopened = client(sdkStorage(values, key)); try { await reopened.auth.initialize(); expect((await reopened.auth.getSession()).data.session?.access_token).toBe(newer.access_token); } finally { await reopened.auth.dispose(); }
    } finally { held.resolve(); await holder; stop(); await main.auth.dispose(); await other.auth.dispose(); }
  });

  it.each(['valid', 'missing', 'malformed'] as const)('removes a rotated old login after the matched SDK refresh lock drains without restoring authority: %s', async kind => {
    const key = 'synthetic-refresh-logout'; const loginId = '44444444-4444-4444-8444-444444444444';
    const make = (nonce: number) => {
      const original = sdkSession(); const payload = JSON.parse(atob(original.access_token.split('.')[1]!)); delete payload.session_id;
      return { ...original, access_token: `${original.access_token.split('.')[0]}.${btoa(JSON.stringify({ ...payload, ...(kind === 'valid' ? { session_id: loginId } : kind === 'malformed' ? { session_id: 'invalid' } : {}), nonce })).replace(/=/g, '')}.c3ludGhldGlj`, refresh_token: `synthetic-refresh-${nonce}` };
    };
    const old = make(1); const rotated = make(2); const values = new Map([[key, JSON.stringify(old)]]);
    const held = deferred<Response>(); const started = deferred<void>(); const storage = sdkStorage(values, key);
    const transport: typeof fetch = async (url) => {
      if (String(url).includes('/token')) { started.resolve(); return held.promise; }
      if (String(url).includes('/logout')) return new Response(null, { status: 204 });
      return response(200, { user: old.user });
    };
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: storage.storage, lock: storage.lock, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage: storage }), createAppQueryClient(), { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect();
    try {
      await main.auth.initialize();
      const refresh = main.auth.refreshSession(); await started.promise;
      const logout = auth.logout(); expect(auth.getSnapshot().status).toBe('login');
      held.resolve(response(200, rotated)); await refresh; await logout;
      expect(values.has(key)).toBe(false); expect(auth.getSnapshot().session).toBeNull();
      expect((await main.auth.getSession()).data.session).toBeNull();
    } finally { held.resolve(response(200, rotated)); stop(); await main.auth.dispose(); }
  });

  it('checks captured removal after lock acquisition, leaving a newer login that won the lock untouched', async () => {
    const key = 'synthetic-lock-fence'; const old = sdkSession(); const newer = sdkSession(owner, '22222222-2222-4222-8222-222222222222');
    const values = new Map([[key, JSON.stringify(old)]]); const storage = sdkStorage(values, key);
    const entered = deferred<void>(); const held = deferred<void>();
    const winner = storage.lock(`lock:${key}`, 5000, async () => { entered.resolve(); await held.promise; values.set(key, JSON.stringify(newer)); });
    await entered.promise;
    const removal = storage.clearCaptured(old); held.resolve(); await winner; await removal;
    expect(JSON.parse(values.get(key)!)).toEqual(newer);
  });

  it.each(['missing', 'malformed'])('does not treat rotated unknown login identity as fresh authority: %s', async kind => {
    const h = harness(); const waiting = deferred<{ error: unknown }>(); h.port.signOut = () => waiting.promise;
    const encoded = btoa(JSON.stringify({ sub: owner, ...(kind === 'malformed' ? { session_id: 'not-a-session-id' } : {}) }));
    h.emit('SIGNED_IN', session(owner, `e30.${encoded}.old`));
    const logout = h.auth.logout();
    h.emit('SIGNED_IN', { ...session(owner, `e30.${encoded}.rotated`), refresh_token: 'rotated-refresh' });
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'login', ownerId: null });
    waiting.resolve({ error: null }); await logout; h.disconnect();
  });

  it('fails closed on corrupt SDK storage and never deletes replacement bytes', async () => {
    const key = 'synthetic-corrupt-storage'; const values = new Map([[key, '{corrupt']]); const storage = sdkStorage(values, key);
    await expect(storage.clearCaptured(sdkSession())).rejects.toThrow();
    expect(values.get(key)).toBe('{corrupt');
    const replacement = sdkSession(other); values.set(key, JSON.stringify(replacement));
    await storage.clearCaptured(sdkSession()); expect(JSON.parse(values.get(key)!)).toEqual(replacement);
    const legacy = session(); values.set(key, JSON.stringify(legacy)); await storage.clearCaptured(legacy); expect(values.has(key)).toBe(false);
  });

  it('preserves the recovery form through the installed SDK hidden-to-visible session recovery path', async () => {
    const key = 'synthetic-visibility-session'; const values = new Map([[key, JSON.stringify(sdkSession())]]);
    const sessionStorage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: sessionStorage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async () => response(200, { user: sdkSession().user }) } });
    const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', sessionStorage }), createAppQueryClient(), { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect(); const probe = main.auth as unknown as SdkProbe;
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().ownerId).toBe(owner));
      await sdkRecovery(probe, sessionStorage, key, sdkSession());
      await waitFor(() => expect(auth.getSnapshot().status).toBe('recovery')); render(<LoginPage auth={auth} />);
      fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'synthetic-new-password' } });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); await probe._onVisibilityChanged(false);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); await act(async () => { await probe._onVisibilityChanged(false); });
      expect(auth.getSnapshot().status).toBe('recovery'); expect(screen.getByLabelText('Nova senha')).toHaveValue('synthetic-new-password');
    } finally { cleanup(); stop(); await main.auth.dispose(); if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility); else Reflect.deleteProperty(document, 'visibilityState'); }
  });

  it('does not promote a pending SDK login A after a newer external SDK SIGNED_IN B', async () => {
    const key = 'synthetic-login-session'; const values = new Map([[key, JSON.stringify(sdkSession())]]);
    const pending = deferred<Response>(); const started = deferred<void>();
    const transport: typeof fetch = async (url) => {
      if (new URL(String(url)).pathname.endsWith('/token')) { started.resolve(); return pending.promise; }
      return response(200, { user: sdkSession().user });
    };
    const sessionStorage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: sessionStorage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const cache = createAppQueryClient(); const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage }), cache, { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect(); const probe = main.auth as unknown as SdkProbe;
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().ownerId).toBe(owner));
      const login = auth.login('synthetic@example.invalid', 'synthetic-password').catch(() => undefined); await started.promise;
      const ownerB = sdkSession(other); values.set(key, JSON.stringify(ownerB)); await probe._notifyAllSubscribers('SIGNED_IN', ownerB, false);
      const intent = createSaveIntent({ auth, api: createApiClient(auth), draft, readCurrent: async () => current }); cache.setQueryData(['owner-b'], { notes: 'synthetic B' });
      pending.resolve(response(200, sdkSession())); await login;
      expect(auth.getSnapshot().ownerId).toBe(other); expect(JSON.parse(values.get(key)!)).toEqual(ownerB);
      expect(intent.getSnapshot().draft).toEqual(draft); expect(cache.getQueryData(['owner-b'])).toEqual({ notes: 'synthetic B' });
    } finally { stop(); await main.auth.dispose(); }
  });

  it('fences main SDK setSession after its GET/user yields without blocking a newer B token refresh', async () => {
    const key = 'synthetic-promotion-session'; const values = new Map([[key, JSON.stringify(sdkSession())]]);
    const userResponse = deferred<Response>(); const started = deferred<void>();
    const ownerA = sdkSession(); const ownerB = sdkSession(other);
    const renewedB = { ...ownerB, access_token: ownerB.access_token + 'renewed', refresh_token: 'synthetic-renewed-B' };
    const transport: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/token')) return response(200, parsed.searchParams.get('grant_type') === 'refresh_token' ? renewedB : ownerA);
      if (new Headers(init?.headers).get('Authorization') === `Bearer ${ownerA.access_token}`) { started.resolve(); return userResponse.promise; }
      return response(200, { user: ownerB.user });
    };
    const sessionStorage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: sessionStorage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const cache = createAppQueryClient(); const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage }), cache, { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect(); const probe = main.auth as unknown as SdkProbe;
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().ownerId).toBe(owner));
      const login = auth.login('synthetic@example.invalid', 'synthetic-password').catch(() => undefined); await started.promise;
      values.set(key, JSON.stringify(ownerB)); await probe._notifyAllSubscribers('SIGNED_IN', ownerB, false);
      const intent = createSaveIntent({ auth, api: createApiClient(auth), draft, readCurrent: async () => current }); cache.setQueryData(['owner-b'], { notes: 'synthetic B' });
      expect((await main.auth.refreshSession()).data.session?.access_token).toBe(renewedB.access_token);
      userResponse.resolve(response(200, { user: ownerA.user })); await login;
      expect(auth.getSnapshot()).toMatchObject({ ownerId: other, session: { access_token: renewedB.access_token, refresh_token: renewedB.refresh_token } });
      expect(JSON.parse(values.get(key)!)).toMatchObject({ user: { id: other }, access_token: renewedB.access_token, refresh_token: renewedB.refresh_token });
      expect(intent.getSnapshot().draft).toEqual(draft); expect(cache.getQueryData(['owner-b'])).toEqual({ notes: 'synthetic B' });
      // The candidate guard is released after notification/completion, so the
      // still-current B can subsequently use supported SDK session operations.
      expect((await main.auth.setSession(renewedB)).error).toBeNull();
      expect(auth.getSnapshot().ownerId).toBe(other);
    } finally { stop(); await main.auth.dispose(); }
  });

  it('persists an ordinary successful isolated login through guarded SDK promotion', async () => {
    const key = 'synthetic-successful-login'; const values = new Map([[key, JSON.stringify(sdkSession())]]); const ownerB = sdkSession(other);
    const transport: typeof fetch = async (url) => response(200, new URL(String(url)).pathname.endsWith('/token') ? ownerB : { user: ownerB.user });
    const sessionStorage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: sessionStorage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage }), createAppQueryClient(), { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect();
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().ownerId).toBe(owner));
      await auth.login('synthetic@example.invalid', 'synthetic-password');
      expect(auth.getSnapshot()).toMatchObject({ ownerId: other, status: 'authenticated', session: { access_token: ownerB.access_token, refresh_token: ownerB.refresh_token } });
      expect(JSON.parse(values.get(key)!)).toMatchObject({ user: { id: other }, access_token: ownerB.access_token, refresh_token: ownerB.refresh_token });
      expect((await main.auth.getSession()).data.session?.user.id).toBe(other);
    } finally { stop(); await main.auth.dispose(); }
  });

  it('keeps the exact candidate storage fence until actual SDK subscriber notification settles', async () => {
    const key = 'synthetic-notification-session'; const values = new Map([[key, JSON.stringify(sdkSession())]]); const ownerA = sdkSession(); const ownerB = sdkSession(other);
    const transport: typeof fetch = async (url) => response(200, new URL(String(url)).pathname.endsWith('/token') ? ownerA : { user: ownerA.user });
    const sessionStorage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: sessionStorage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage }), createAppQueryClient(), { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect(); const probe = main.auth as unknown as SdkProbe; const notified = deferred<void>(); const finish = deferred<void>();
    let blocker: ReturnType<typeof main.auth.onAuthStateChange> | undefined;
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().ownerId).toBe(owner));
      blocker = main.auth.onAuthStateChange(async (event, value) => { if (event === 'SIGNED_IN' && value?.access_token === ownerA.access_token) { notified.resolve(); await finish.promise; } });
      const login = auth.login('synthetic@example.invalid', 'synthetic-password'); await notified.promise;
      values.set(key, JSON.stringify(ownerB)); await probe._notifyAllSubscribers('SIGNED_IN', ownerB, false);
      await expect(main.auth.setSession(ownerA)).rejects.toThrow(/substituída/i);
      expect(JSON.parse(values.get(key)!)).toEqual(ownerB); expect(auth.getSnapshot().ownerId).toBe(other);
      finish.resolve(); await login; expect(auth.getSnapshot().ownerId).toBe(other);
    } finally { finish.resolve(); blocker?.data.subscription.unsubscribe(); stop(); await main.auth.dispose(); }
  });

  it.each(['acquisition', 'promotion'] as const)('supersedes a pending first login during %s when B establishes the initial SDK identity', async (phase) => {
    const key = `synthetic-empty-${phase}`; const values = new Map<string, string>();
    const pending = deferred<Response>(); const started = deferred<void>(); const ownerA = sdkSession(); const ownerB = sdkSession(other);
    const transport: typeof fetch = async (url) => {
      const token = new URL(String(url)).pathname.endsWith('/token');
      if (phase === 'acquisition' ? token : !token) { started.resolve(); return pending.promise; }
      return response(200, token ? ownerA : { user: ownerA.user });
    };
    const sessionStorage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: sessionStorage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const cache = createAppQueryClient(); const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage }), cache, { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect(); const probe = main.auth as unknown as SdkProbe;
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().status).toBe('login'));
      expect(auth.getSnapshot().ownerId).toBeNull(); expect(values.has(key)).toBe(false);
      const login = auth.login('synthetic@example.invalid', 'synthetic-password').catch((error: unknown) => error); await started.promise;
      values.set(key, JSON.stringify(ownerB)); await probe._notifyAllSubscribers('SIGNED_IN', ownerB, false);
      const intent = createSaveIntent({ auth, api: createApiClient(auth), draft, readCurrent: async () => current }); cache.setQueryData(['owner-b'], { notes: 'synthetic B' });
      pending.resolve(response(200, phase === 'acquisition' ? ownerA : { user: ownerA.user }));
      const outcome: unknown = await login;
      expect(auth.getSnapshot()).toMatchObject({ ownerId: other, status: 'authenticated', session: { access_token: ownerB.access_token, refresh_token: ownerB.refresh_token } });
      expect(JSON.parse(values.get(key)!)).toEqual(ownerB); expect((await main.auth.getSession()).data.session?.user.id).toBe(other);
      expect(intent.getSnapshot().draft).toEqual(draft); expect(cache.getQueryData(['owner-b'])).toEqual({ notes: 'synthetic B' });
      expect(outcome).toBeInstanceOf(Error);
    } finally { stop(); await main.auth.dispose(); }
  });

  it('completes and persists an ordinary first SDK login from empty storage', async () => {
    const key = 'synthetic-ordinary-first-login'; const values = new Map<string, string>(); const ownerA = sdkSession();
    const transport: typeof fetch = async (url) => response(200, new URL(String(url)).pathname.endsWith('/token') ? ownerA : { user: ownerA.user });
    const sessionStorage = sdkStorage(values, key);
    const main = createClient('https://sdk-synthetic.invalid', 'sb_publishable_synthetic', { auth: { storageKey: key, storage: sessionStorage.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
    const auth = createAuthController(createSdkAuthPort(main.auth, { url: 'https://sdk-synthetic.invalid', publishableKey: 'sb_publishable_synthetic', fetch: transport, sessionStorage }), createAppQueryClient(), { subscribe: () => () => {}, publish() {} });
    const stop = auth.connect();
    try {
      await main.auth.initialize(); await waitFor(() => expect(auth.getSnapshot().status).toBe('login'));
      expect(auth.getSnapshot().ownerId).toBeNull(); expect(values.has(key)).toBe(false);
      await auth.login('synthetic@example.invalid', 'synthetic-password');
      expect(auth.getSnapshot()).toMatchObject({ ownerId: owner, status: 'authenticated', session: { access_token: ownerA.access_token, refresh_token: ownerA.refresh_token } });
      expect(JSON.parse(values.get(key)!)).toMatchObject({ user: { id: owner }, access_token: ownerA.access_token, refresh_token: ownerA.refresh_token });
      expect((await main.auth.getSession()).data.session?.user.id).toBe(owner);
    } finally { stop(); await main.auth.dispose(); }
  });
});
