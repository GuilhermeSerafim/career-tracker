// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, it, expect, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { createAppRuntime } from '../../src/app/runtime';
import { AgentCredentials } from '../../src/features/settings/AgentCredentials';
import { StrictMode } from 'react';
import { createCredentialSession } from '../../src/features/settings/credential-session';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function setup() {
  vi.stubGlobal('crypto', webcrypto);
  const session = { access_token: 'synthetic', user: { id: '11111111-1111-4111-8111-111111111111' } } as Session;
  let authChange!: (event: AuthChangeEvent, session: Session | null) => void;
  const writes: { body: Record<string, unknown>; key: string | null }[] = [];
  let fail = true;
  const runtime = createAppRuntime({ onAuthStateChange(listener) { authChange = listener; queueMicrotask(() => listener('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; }, signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) }, async (input, init) => {
    if (String(input).includes('/agent-credentials')) return Response.json({ items: [], nextCursor: null });
    const body = JSON.parse(String(init?.body)); writes.push({ body, key: new Headers(init?.headers).get('Idempotency-Key') });
    if (fail) return Response.json({}, { status: 503 });
    return Response.json({ credential: { id: body.clientId, version: 1, label: body.label, prefix: body.prefix, scopes: body.scopes, expiresAt: body.expiresAt, revokedAt: null, createdAt: new Date().toISOString() } }, { status: 201 });
  });
  await act(async () => { await Promise.resolve(); });
  const view = render(<StrictMode><AgentCredentials runtime={runtime} /></StrictMode>);
  return { runtime, writes, view, succeed: () => { fail = false; }, reenter: () => act(() => authChange('SIGNED_IN', session)), switchOwner: () => act(() => authChange('SIGNED_IN', { ...session, user: { id: '22222222-2222-4222-8222-222222222222' } } as Session)) };
}
it('keeps one intention on uncertain retry, reveals once only after confirmation and clears on unmount', async () => {
  const h = await setup();
  fireEvent.change(screen.getByLabelText('Nome da credencial'), { target: { value: 'Agente fictício' } });
  fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));
  await screen.findByRole('button', { name: 'Repetir mesma criação' });
  expect(screen.queryByLabelText('Credencial exibida uma vez')).not.toBeInTheDocument();
  h.succeed(); fireEvent.click(screen.getByRole('button', { name: 'Repetir mesma criação' }));
  const field = await screen.findByLabelText('Credencial exibida uma vez') as HTMLTextAreaElement;
  const token = field.value;
  expect(field.readOnly).toBe(true);
  act(() => field.focus());
  expect(document.activeElement === field).toBe(true);
  expect(field.selectionStart === 0 && field.selectionEnd === token.length).toBe(true);
  expect(token.startsWith('ct_agent_')).toBe(true); expect(h.writes).toHaveLength(2);
  expect(JSON.stringify(h.writes[0]) === JSON.stringify(h.writes[1])).toBe(true);
  expect(JSON.stringify(h.writes).includes(token)).toBe(false);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  fireEvent.click(screen.getByText('Guardei em local privado; ocultar'));
  expect(screen.queryByLabelText('Credencial exibida uma vez')).not.toBeInTheDocument();
  h.view.unmount(); render(<AgentCredentials runtime={h.runtime} />);
  expect(screen.queryByLabelText('Credencial exibida uma vez')).not.toBeInTheDocument();
  await h.runtime.dispose();
});
it.each(['switch', 'expire-reenter', 'logout'] as const)('sends zero commands after authority changes during hashing: %s', async transition => {
  const h = await setup(); const session = createCredentialSession(h.runtime); session.connect();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const digest = vi.fn(async (algorithm: AlgorithmIdentifier, data: BufferSource) => { await blocked; return webcrypto.subtle.digest(algorithm, data as never); });
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID: webcrypto.randomUUID.bind(webcrypto), subtle: { digest } });
  const creation = session.create('Sintético', ['career:read'], null);
  expect(digest).toHaveBeenCalledTimes(1);
  if (transition === 'switch') h.switchOwner();
  else if (transition === 'logout') await act(async () => { await h.runtime.auth.logout(); });
  else { act(() => h.runtime.auth.expire()); h.reenter(); }
  release(); await act(async () => { await creation; });
  expect(h.writes.length).toBe(0); expect(session.getSnapshot().token === null).toBe(true);
  session.dispose(); h.view.unmount(); await h.runtime.dispose();
});
it('does not reveal late successful creation after owner switch', async () => {
  const h = await setup(); const session = createCredentialSession(h.runtime); session.connect();
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }); let submitted = false;
  vi.spyOn(h.runtime.api, 'command').mockImplementation(async body => {
    const command = JSON.parse(body); submitted = true; await blocked;
    return { credential: { id: command.clientId, version: 1, label: command.label, prefix: command.prefix, scopes: command.scopes, expiresAt: null, revokedAt: null, createdAt: new Date().toISOString() } };
  });
  const creating = session.create('Sintético', ['career:read'], null);
  await waitFor(() => expect(submitted).toBe(true)); h.switchOwner(); release(); await creating;
  expect(session.getSnapshot().token === null).toBe(true); expect(session.getSnapshot().status).toBe('forgotten');
  session.dispose(); h.view.unmount(); await h.runtime.dispose();
});
it('does not report an empty catalog on failure or create from native invalid expiry input', async () => {
  const h = await setup();
  await screen.findByText('Nenhuma credencial nesta página.');
  vi.spyOn(h.runtime.api, 'read').mockRejectedValue(new Error('unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Reler credenciais' }));
  await screen.findByText('Não foi possível reler as credenciais.');
  expect(screen.queryByText('Nenhuma credencial nesta página.')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Nome da credencial'), { target: { value: 'Sintético' } });
  const expiry = screen.getByLabelText('Expira em (opcional)') as HTMLInputElement;
  expiry.setCustomValidity('Data incompleta');
  fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(h.writes.length).toBe(0);
  h.view.unmount(); await h.runtime.dispose();
});
it('allows correction after a definite validation rejection without retaining secret or retry', async () => {
  const h = await setup();
  vi.spyOn(h.runtime.api, 'command').mockRejectedValue(new (await import('../../src/lib/api')).ApiError(400));
  const session = createCredentialSession(h.runtime); session.connect();
  await session.create('Sintético', ['career:read'], '2000-01-01T00:00:00Z');
  expect(session.getSnapshot().status).toBe('idle'); expect(session.getSnapshot().token === null).toBe(true);
  session.dispose(); h.view.unmount(); await h.runtime.dispose();
});
it('purges an unconfirmed secret at expiry rather than reviving it on same-owner reentry', async () => {
  const h = await setup();
  fireEvent.change(screen.getByLabelText('Nome da credencial'), { target: { value: 'Agente fictício' } });
  fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));
  await screen.findByRole('button', { name: 'Repetir mesma criação' });
  act(() => h.runtime.auth.expire()); h.reenter();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Repetir mesma criação' })).not.toBeInTheDocument());
  expect(screen.queryByLabelText('Credencial exibida uma vez')).not.toBeInTheDocument();
  h.view.unmount(); await h.runtime.dispose();
});
