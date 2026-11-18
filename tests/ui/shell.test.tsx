// @vitest-environment jsdom
import '../../src/app/validation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { AuthPort } from '../../src/lib/auth';
import { App } from '../../src/app/App';
import { createAppRuntime } from '../../src/app/runtime';

afterEach(cleanup);
const session = (id = '11111111-1111-4111-8111-111111111111'): Session => ({
  access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer',
  user: { id, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} },
});
function harness(status = 200, override?: typeof fetch) {
  const listeners = new Set<(event: AuthChangeEvent, value: Session | null) => void>();
  const port: AuthPort = {
    onAuthStateChange: vi.fn((callback) => { listeners.add(callback); return { data: { subscription: { unsubscribe: () => { listeners.delete(callback); } } } }; }),
    signInWithPassword: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }),
    signOut: vi.fn(async () => ({ error: null })), dispose: vi.fn(async () => {}),
  };
  // These lifecycle probes hold/count owner checks, independently of route reads.
  const health = override ?? (async () => new Response(JSON.stringify(status === 200 ? { status: 'ok' } : { error: {} }), { status }));
  const transport = vi.fn<typeof fetch>(async (input, init) => String(input).endsWith('/health') ? health(input, init) : Response.json({}, { status: 503 }));
  const runtime = createAppRuntime(port, transport);
  const emit = (event: AuthChangeEvent, value: Session | null) => { act(() => { listeners.forEach((listener) => listener(event, value)); }); };
  const mount = (path = '/') => render(<StrictMode><MemoryRouter initialEntries={[path]}><App runtime={runtime} /></MemoryRouter></StrictMode>);
  return { runtime, port, transport, listeners, emit, mount };
}

describe('runtime and protected shell (synthetic Auth/network only)', () => {
  it('connects synchronously once before initialization yields and keeps runtime drafts through same-owner expiration', async () => {
    const h = harness(); expect(h.listeners.size).toBe(1);
    h.emit('INITIAL_SESSION', session()); const view = h.mount();
    await screen.findByRole('heading', { name: 'Seu próximo passo.' });
    expect(h.port.onAuthStateChange).toHaveBeenCalledTimes(1);
    const draft = { dispose: vi.fn(), text: 'synthetic unsaved edit' };
    expect(h.runtime.retainDraft('edit', () => draft)).toBe(draft);
    h.emit('SIGNED_OUT', null);
    await screen.findByRole('heading', { name: 'Entrar' });
    expect(draft.dispose).not.toHaveBeenCalled();
    h.emit('SIGNED_IN', session());
    expect(h.runtime.retainDraft('edit', () => ({ ...draft }))).toBe(draft);
    await screen.findByRole('heading', { name: 'Seu próximo passo.' });
    h.emit('SIGNED_IN', session('22222222-2222-4222-8222-222222222222'));
    expect(draft.dispose).toHaveBeenCalledOnce();
    view.unmount(); await h.runtime.dispose();
    expect(h.listeners.size).toBe(0);
    expect(h.port.dispose).toHaveBeenCalledOnce();
  });
  it('routes all four destinations, deep links, settings and explicit controller logout by keyboard', async () => {
    const h = harness(); h.emit('INITIAL_SESSION', session()); h.mount('/vagas');
    await screen.findByRole('heading', { name: 'Vagas' });
    const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
    expect(nav.querySelectorAll('a')).toHaveLength(4);
    expect(screen.getByRole('link', { name: /Vagas/ })).toHaveAttribute('aria-current', 'page');
    screen.getByRole('link', { name: /Análises/ }).focus(); await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Análises' })).toHaveFocus();
    screen.getByRole('link', { name: /Revisões/ }).focus(); await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Revisões' })).toHaveFocus();
    screen.getByRole('link', { name: /Hoje/ }).focus(); await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Seu próximo passo.' });
    const account = screen.getByRole('button', { name: 'Conta' });
    account.focus(); await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Tab}{Enter}');
    expect(screen.getByRole('heading', { name: 'Configurações' })).toHaveFocus();
    await userEvent.click(account); await userEvent.click(screen.getByRole('button', { name: 'Sair da conta' }));
    await screen.findByRole('heading', { name: 'Entrar' });
    await waitFor(() => expect(h.port.signOut).toHaveBeenCalledOnce());
    await h.runtime.dispose();
  });
  it('blocks loading, login, forbidden and unavailable states without rendering private route content', async () => {
    const h = harness(403); h.mount('/revisoes');
    expect(screen.getByRole('status')).toHaveTextContent('Verificando acesso');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    h.emit('INITIAL_SESSION', null);
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    h.emit('SIGNED_IN', session());
    await screen.findByRole('heading', { name: 'Acesso não autorizado' });
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    await h.runtime.dispose(); cleanup();
    const down = harness(503); down.emit('INITIAL_SESSION', session()); down.mount();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    await down.runtime.dispose(); cleanup();
    render(<MemoryRouter><App runtime={null} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Acesso indisponível' })).toBeInTheDocument();
  });
  it('handles password recovery callback before protected content and returns home after update', async () => {
    const h = harness(); h.emit('PASSWORD_RECOVERY', session()); h.mount('/recuperar-senha');
    expect(screen.getByRole('heading', { name: 'Definir nova senha' })).toBeInTheDocument();
    expect(h.transport).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Nova senha'), 'synthetic-password');
    await userEvent.click(screen.getByRole('button', { name: 'Alterar senha' }));
    await screen.findByRole('heading', { name: 'Seu próximo passo.' });
    await h.runtime.dispose();
  });
  it('drains pending credentials before disposing main auth and forbids draft creation while signed out', async () => {
    const h = harness(); h.emit('INITIAL_SESSION', null);
    expect(() => h.runtime.retainDraft('edit', () => ({ dispose() {} }))).toThrow();
    let resolve!: (value: { error: null }) => void;
    h.port.signInWithPassword = () => new Promise((done) => { resolve = done; });
    const login = h.runtime.auth.login('synthetic@example.invalid', 'synthetic-password');
    const teardown = h.runtime.dispose();
    expect(h.port.dispose).not.toHaveBeenCalled();
    resolve({ error: null }); await login; await teardown;
    expect(h.port.signOut).toHaveBeenCalledOnce();
    expect(h.port.dispose).toHaveBeenCalledOnce();
  });
  it('does not show an old logout failure after a newer login expires', async () => {
    const h = harness(); h.port.signOut = async () => ({ error: new Error('synthetic unavailable') });
    h.emit('INITIAL_SESSION', session()); const view = h.mount();
    await screen.findByRole('heading', { name: 'Seu próximo passo.' });
    await userEvent.click(screen.getByRole('button', { name: 'Conta' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sair da conta' }));
    await screen.findByText('A sessão local foi encerrada. Não foi possível confirmar a saída no serviço.');
    await h.runtime.auth.login('synthetic@example.invalid', 'synthetic-password');
    h.emit('SIGNED_IN', session());
    await screen.findByRole('heading', { name: 'Seu próximo passo.' });
    h.emit('SIGNED_OUT', null);
    expect(screen.queryByText('A sessão local foi encerrada. Não foi possível confirmar a saída no serviço.')).not.toBeInTheDocument();
    view.unmount(); await expect(h.runtime.dispose()).rejects.toThrow();
  });
  it.each([[false, 403], [false, 200], [true, 403], [true, 200]] as const)('requires fresh owner access after reauthentication (batched=%s, status=%s)', async (batched, status) => {
    let calls = 0; let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    const h = harness(200, async () => ++calls === 2 ? held : new Response('{"status":"ok"}', { status: 200 }));
    h.emit('INITIAL_SESSION', session()); const view = h.mount();
    try {
      await screen.findByRole('navigation');
      const generation = h.runtime.auth.getSnapshot().generation;
      const draft = { dispose: vi.fn(), text: 'synthetic retained draft' };
      h.runtime.retainDraft('edit', () => draft);
      h.emit('TOKEN_REFRESHED', { ...session(), access_token: 'synthetic-refreshed' });
      screen.getByRole('link', { name: /Vagas/ }).focus(); await userEvent.keyboard('{Enter}');
      expect(screen.getByRole('navigation')).toBeInTheDocument(); expect(calls).toBe(1);
      const reauthenticate = () => h.emit('SIGNED_IN', { ...session(), access_token: 'synthetic-reauthenticated' });
      if (batched) act(() => { h.runtime.auth.expire(); reauthenticate(); });
      else { act(() => h.runtime.auth.expire()); expect(screen.queryByRole('navigation')).not.toBeInTheDocument(); reauthenticate(); }
      await waitFor(() => expect(calls).toBe(2));
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Verificando acesso');
      expect(h.runtime.auth.getSnapshot().generation).toBe(generation);
      expect(h.runtime.retainDraft('edit', () => ({ dispose() {}, text: 'replacement' }))).toBe(draft);
      expect(draft.dispose).not.toHaveBeenCalled();
      await act(async () => release(new Response(status === 200 ? '{"status":"ok"}' : '{"error":{}}', { status })));
      if (status === 403) {
        await screen.findByRole('heading', { name: 'Acesso não autorizado' });
        expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
      }
      await screen.findByRole('navigation');
      expect(calls).toBe(status === 403 ? 3 : 2);
      expect(draft.dispose).not.toHaveBeenCalled();
    } finally { release(new Response('{"error":{}}', { status: 503 })); view.unmount(); await h.runtime.dispose(); }
  });
});
