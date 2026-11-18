// @vitest-environment jsdom
import '../../src/app/validation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router';
import type { Session } from '@supabase/supabase-js';
import { App } from '../../src/app/App';
import { createAppRuntime } from '../../src/app/runtime';
import type { AuthPort } from '../../src/lib/auth';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const appId = '11111111-1111-4111-8111-111111111111';
const oldId = '22222222-2222-4222-8222-222222222222';
const day = (value: string) => ({ precision: 'day', certainty: 'exact', value });
function data() {
  const event = { id: 'event', applicationId: oldId, canonicalApplicationId: oldId, kind: 'entrevista', state: 'concluido', occurredDate: day('2026-10-02'), recordedAt: '2026-11-15T18:00:00Z', resultText: 'Conversa concluída.', scoreValue: null, scoreUnit: null, sourceText: null, supersedesEventId: null };
  return { date: '2026-11-15', asOf: '2026-11-15T19:00:00Z', dailyGoal: 7, submitted: { count: 2, applicationIds: [appId] }, unknownDateApplicationIds: [oldId],
    tasks: [
      { id: '1', applicationId: appId, contactId: null, title: 'Retomar conversa', dueDate: day('2026-11-14'), dueGroup: 'overdue' },
      { id: '2', applicationId: appId, contactId: null, title: 'Preparar entrevista', dueDate: day('2026-11-15'), dueGroup: 'today' },
      { id: '3', applicationId: appId, contactId: null, title: 'Revisar anotações', dueDate: day('2026-11-18'), dueGroup: 'future' },
      { id: '4', applicationId: appId, contactId: null, title: 'Organizar dúvidas', dueDate: { precision: 'month', certainty: 'approximate', value: '2026-12' }, dueGroup: 'no_exact_deadline' },
    ], recentEvents: [event], historicalResults: [event] };
}
async function mount(options: { empty?: boolean; failed?: boolean; metadataFailed?: boolean; held?: boolean; contactOnly?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-16T01:30:00Z'));
  let failed = options.failed;
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const transport: typeof fetch = async (input) => {
    const path = String(input);
    if (path.endsWith('/health')) return Response.json({ status: 'ok' });
    if (path.endsWith('/settings')) return Response.json({ timezone: 'America/Sao_Paulo', dailyGoal: 7 });
    if (path === '/api/v1/today?date=2026-11-15') {
      if (options.held) await held;
      if (failed) return Response.json({ error: {} }, { status: 503 });
      return Response.json(options.empty ? { ...data(), submitted: { count: 0, applicationIds: [] }, tasks: [], recentEvents: [], historicalResults: [], unknownDateApplicationIds: [] } : options.contactOnly ? { ...data(), tasks: [{ ...data().tasks[0], applicationId: null, contactId: oldId, title: 'Retomar conversa independente' }] } : data());
    }
    if (path.startsWith('/api/v1/applications?')) return options.metadataFailed ? Response.json({}, { status: 503 }) : Response.json({ items: [
      { id: appId, displayId: 'N000001', opportunity: { company: '<Empresa fictícia>', title: 'Engenharia' } },
      { id: oldId, displayId: 'V001', opportunity: { company: 'Empresa anterior', title: 'Produto' } },
    ], total: 2, nextCursor: null });
    if (path === `/api/v1/contacts/${oldId}`) return Response.json({ id: oldId, version: 1, name: null, notes: '<Nota informada>', links: [{ originalUrl: 'https://example.test/chat?token=synthetic', kind: 'conversa', isLocal: false, isPrivate: true }] });
    return Response.json({}, { status: 503 });
  };
  const port: AuthPort = { onAuthStateChange: (callback) => {
    queueMicrotask(() => callback('INITIAL_SESSION', { access_token: 'synthetic', user: { id: appId } } as Session));
    return { data: { subscription: { unsubscribe() {} } } };
  }, signInWithPassword: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }), signOut: async () => ({ error: null }) };
  const runtime = createAppRuntime(port, transport);
  const view = render(<MemoryRouter><App runtime={runtime} /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Seu próximo passo.' });
  return { retry: () => { failed = false; }, release, close: async () => { release(); view.unmount(); await runtime.dispose(); } };
}

describe('Hoje through the guarded runtime (synthetic Auth/network)', () => {
  it('uses the settings local day and server count/goal, preserving task order and navigation', async () => {
    const h = await mount();
    const goal = await screen.findByRole('region', { name: 'Meta de hoje' });
    expect(goal).toHaveTextContent('2 de 7');
    expect(screen.getByRole('link', { name: /Registrar candidatura/ })).toHaveAttribute('href', '/vagas/nova');
    const tasks = screen.getByRole('region', { name: 'Próximas ações' });
    const links = within(tasks).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Retomar conversa')]));
    expect(links.map((link) => link.textContent?.split('↗')[0])).toEqual(['Retomar conversa', 'Preparar entrevista', 'Revisar anotações', 'Organizar dúvidas']);
    expect(tasks).toHaveTextContent('Atrasada'); expect(tasks).toHaveTextContent('Sem prazo exato');
    expect(tasks).toHaveTextContent('dezembro de 2026 (aproximado)');
    expect(tasks).toHaveTextContent('<Empresa fictícia>');
    links[0]!.focus(); await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Vagas' })).toBeInTheDocument();
    await h.close();
  });
  it('keeps historical outcomes separate and renders occurrence and record dates honestly', async () => {
    const h = await mount();
    const history = await screen.findByRole('region', { name: 'Resultados de processos anteriores' });
    expect(history).toHaveTextContent('Entrevista'); expect(history).toHaveTextContent('Concluído');
    expect(history).toHaveTextContent('Aconteceu em 02/10/2026'); expect(history).toHaveTextContent('Registrado em 15/11/2026');
    expect(screen.getByRole('region', { name: 'Meta de hoje' })).not.toHaveTextContent('Entrevista');
    expect(screen.getByText(/1 candidatura sem dia exato/)).toBeInTheDocument();
    await h.close();
  });
  it('keeps a heading while loading and shows a retryable failure without a zero count', async () => {
    const h = await mount({ failed: true, held: true });
    expect(screen.getByRole('status')).toHaveTextContent('Carregando sua rotina');
    expect(screen.queryByRole('region', { name: 'Meta de hoje' })).not.toBeInTheDocument();
    h.release(); await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: 'Meta de hoje' })).not.toBeInTheDocument();
    h.retry(); await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('region', { name: 'Meta de hoje' })).toHaveTextContent('2 de 7');
    await h.close();
  });
  it('guides first registration only after a successful empty response', async () => {
    const h = await mount({ empty: true });
    expect(await screen.findByText(/Registre sua primeira candidatura/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Meta de hoje' })).toHaveTextContent('0 de 7');
    expect(screen.getByText('Nenhuma ação pendente.')).toBeInTheDocument();
    await h.close();
  });
  it('does not turn a metadata failure into invented company labels or an empty success', async () => {
    const h = await mount({ metadataFailed: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar sua rotina');
    expect(screen.queryByRole('region', { name: 'Meta de hoje' })).not.toBeInTheDocument();
    await h.close();
  });
  it('opens actual read-only contact detail for a contact-only task by keyboard, without a placeholder route', async () => {
    const h = await mount({ contactOnly: true });
    const button = await screen.findByRole('button', { name: 'Retomar conversa independente' });
    expect(screen.queryByText('<Nota informada>')).not.toBeInTheDocument();
    button.focus(); await userEvent.keyboard('{Enter}');
    const contact = await screen.findByRole('region', { name: 'Detalhes da conversa' });
    expect(contact).toHaveTextContent('Nome não informado'); expect(contact).toHaveTextContent('<Nota informada>');
    expect(within(contact).getByRole('link', { name: /Abrir conversa 1/ })).toHaveAttribute('href', 'https://example.test/chat?token=synthetic');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Enter}'); expect(screen.queryByRole('region', { name: 'Detalhes da conversa' })).not.toBeInTheDocument();
    await h.close();
  });
});
