// @vitest-environment jsdom
import '../../src/app/validation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import type { Session } from '@supabase/supabase-js';
import type { AnalyticsQuery, AnalyticsResult, AnalyticsRow, AnalyticsGroup } from '../../shared/analytics';
import { buildAnalytics } from '../../domain/metrics';
import AnalyticsPage from '../../src/features/analytics/AnalyticsPage';
import { ListPage } from '../../src/features/applications/ListPage';
import { createAppRuntime } from '../../src/app/runtime';
import type { AuthPort } from '../../src/lib/auth';

const engine = vi.hoisted(() => ({ instances: [] as { element: HTMLElement; option: Record<string, unknown>; click: (event: unknown) => void; resize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> }[] }));
vi.mock('echarts/core', () => ({ use: vi.fn(), init: (element: HTMLElement) => {
  const instance = { element, option: {}, click: (_event: unknown) => { void _event; }, resize: vi.fn(), dispose: vi.fn(), off: vi.fn(), setOption(option: Record<string, unknown>) { this.option = option; }, on(_name: string, callback: (event: unknown) => void) { this.click = callback; } };
  engine.instances.push(instance); return instance;
} }));
vi.mock('echarts/charts', () => ({ BarChart: {}, LineChart: {} }));
vi.mock('echarts/components', () => ({ GridComponent: {}, LegendComponent: {}, AriaComponent: {}, DataZoomComponent: {} }));
vi.mock('echarts/renderers', () => ({ SVGRenderer: {} }));
const observers: { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
const motion = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
beforeEach(() => {
  engine.instances.length = 0; observers.length = 0;
  vi.stubGlobal('matchMedia', vi.fn(() => motion));
  vi.stubGlobal('ResizeObserver', class { disconnect = vi.fn(); constructor(callback: ResizeObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); } observe() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const query: AnalyticsQuery = { operation: 'metrics', period: { from: '2026-11-14', to: '2026-11-16' }, population: 'confirmed', dimension: 'batch', asOf: '2026-11-17T12:00:00Z', dailyGoal: 5, submissionScope: 'all_dates' };
const occurrenceDateDrilldown = { exactDay: 'a'.repeat(64), imprecise: 'b'.repeat(64), unknown: 'c'.repeat(64) };
function fixture(empty = false, distinct = false): AnalyticsResult {
  const row = (n: number, patch: Partial<AnalyticsRow> = {}): AnalyticsRow => ({ id: id(n), version: 1, displayId: `N${String(n).padStart(6, '0')}`, submissionStatus: 'confirmado', submittedDate: { precision: 'day', certainty: 'exact', value: '2026-11-15' }, countingEligible: true, canonicalApplicationId: null, stage: 'rejeicao', archivedAt: null, cycleRelation: 'after_reset', cycleOrder: n, stack: ['React', 'TS'], discoveryChannel: 'canal_desconhecido', submissionPlatform: '<img src=x onerror=alert(1)>', resumeIds: [], company: null, title: null, seniority: null, modality: null, batchIds: [], ...patch });
  if (distinct) return buildAnalytics([row(1), row(2, { submittedDate: { precision: 'day', certainty: 'exact', value: '2025-01-01' } })], [
    { id: id(21), applicationId: id(1), kind: 'entrevista', state: 'concluido', occurredDate: { precision: 'day', certainty: 'exact', value: '2026-12-01' }, recordedAt: '2026-11-16T12:00:00Z', supersedesEventId: null, resultText: null, scoreValue: null, scoreUnit: null, sourceText: null },
    { id: id(22), applicationId: id(2), kind: 'entrevista', state: 'agendado', occurredDate: { precision: 'day', certainty: 'exact', value: '2026-11-16' }, recordedAt: '2026-11-16T12:00:00Z', supersedesEventId: null, resultText: null, scoreValue: null, scoreUnit: null, sourceText: null },
  ], { ...query, submissionScope: 'submitted_in_period' });
  return buildAnalytics(empty ? [] : [row(1), row(2, { discoveryChannel: null, submittedDate: { precision: 'unknown', value: null }, archivedAt: '2026-11-16T12:00:00Z' }), row(3, { submittedDate: { precision: 'month', certainty: 'approximate', value: '2026-11' } })], empty ? [] : [{ id: id(20), applicationId: id(1), kind: 'retorno_substantivo', state: 'informado', occurredDate: { precision: 'day', certainty: 'exact', value: '2026-11-16' }, recordedAt: '2026-11-16T12:00:00Z', supersedesEventId: null, resultText: null, scoreValue: null, scoreUnit: null, sourceText: null }], query);
}
function Location() { return <output aria-label="Destino">{useLocation().pathname + useLocation().search}</output>; }
function Back() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>Voltar à análise</button>; }
async function mount(options: { empty?: boolean; failed?: boolean; data?: AnalyticsResult; routed?: boolean; initialDrilldown?: string; metadata?: (path: string) => Promise<Response> } = {}) {
  let failed = options.failed; const reads: string[] = [];
  const port: AuthPort = { onAuthStateChange(callback) { queueMicrotask(() => callback('INITIAL_SESSION', { access_token: 'synthetic', user: { id: id(1) } } as Session)); return { data: { subscription: { unsubscribe() {} } } }; }, signInWithPassword: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }), signOut: async () => ({ error: null }) };
  const runtime = createAppRuntime(port, async (input) => { const path = String(input); reads.push(path); if (options.metadata && !path.startsWith('/api/v1/analytics?')) return options.metadata(path); if (failed) return Response.json({}, { status: 503 }); return Response.json({ ...(options.data ?? fixture(options.empty)), occurrenceDateDrilldown }); });
  await waitFor(() => expect(runtime.auth.getSnapshot().status).toBe('authenticated'));
  const view = render(<QueryClientProvider client={runtime.query}><MemoryRouter initialEntries={[options.initialDrilldown ?? '/analises']}>{options.routed ? <Routes><Route path="/analises" element={<AnalyticsPage runtime={runtime} />} /><Route path="/vagas" element={options.initialDrilldown ? <ListPage runtime={runtime} /> : <p>Lista explicativa</p>} /></Routes> : <AnalyticsPage runtime={runtime} />}<Location /><Back /></MemoryRouter></QueryClientProvider>);
  return { reads, runtime, retry: () => { failed = false; }, close: async () => { view.unmount(); await runtime.dispose(); } };
}
function chart(title: string) { return engine.instances.findLast((instance) => instance.element.getAttribute('aria-label')?.startsWith(title))!; }
function referencesFixture() {
  const data = fixture(); const template = data.groups.sentCv[0]!;
  const group = (key: string, application: number): AnalyticsGroup => ({ ...template, key, label: key, isMissing: false, count: 1, applicationIds: [id(application)] });
  data.groups.sentCv = [group(id(80), 1), group(id(81), 3), { ...template, count: 1, applicationIds: [id(2)] }];
  data.selectedGrouping.groups = [group(id(90), 1), { ...data.selectedGrouping.groups[0]!, count: 2, applicationIds: [id(2), id(3)] }];
  return data;
}

describe('accessible evidence-backed analytics', () => {
  it('resolves paginated equal-name CVs and an outside-current batch without changing identities or bar/table URLs', async () => {
    const data = referencesFixture(); const h = await mount({ data, metadata: async (path) => {
      if (path === '/api/v1/resume-refs?limit=100') return Response.json({ items: [{ id: id(80), label: 'Currículo React' }], nextCursor: 'next-page' });
      if (path === '/api/v1/resume-refs?limit=100&cursor=next-page') return Response.json({ items: [{ id: id(81), label: 'Currículo React' }], nextCursor: null });
      if (path === `/api/v1/batches/${id(90)}`) return Response.json({ batch: { id: id(90), batchNumber: 7 }, members: [], versions: [] });
      return Response.json({}, { status: 404 });
    } });
    try {
      const cv = await screen.findByRole('region', { name: 'Currículo efetivamente enviado' });
      await within(cv).findByRole('rowheader', { name: '[1] Currículo React' });
      expect(within(cv).getByRole('rowheader', { name: '[2] Currículo React' })).toBeInTheDocument();
      expect(cv).toHaveTextContent(id(80)); expect(cv).toHaveTextContent(id(81)); expect(cv).toHaveTextContent('Sem CV enviado informado');
      expect(await screen.findByRole('rowheader', { name: '[1] Lote 7' })).toBeInTheDocument();
      expect(h.reads.some((path) => path === '/api/v1/batches?limit=100')).toBe(false);
      await waitFor(() => expect((chart('Currículo efetivamente enviado').option.yAxis as { data: string[] }).data).toContain('[2] Currículo React'));
      for (const [index, key] of [[0, id(80)], [1, id(81)]] as const) {
        const current = [...engine.instances].reverse().find((instance) => instance.element.isConnected && instance.element.getAttribute('aria-label')?.startsWith('Currículo efetivamente enviado'))!;
        current.click({ seriesIndex: 0, dataIndex: index });
        await waitFor(() => expect(screen.getByLabelText('Destino')).toHaveTextContent(encodeURIComponent(key)));
        const destination = screen.getByLabelText('Destino').textContent!;
        const button = within(cv).getByRole('button', { name: `Ver candidaturas: [${index + 1}] Currículo React · ID: ${key}` });
        button.focus(); await userEvent.keyboard('{Enter}'); expect(screen.getByLabelText('Destino').textContent).toBe(destination);
        expect(JSON.parse(new URLSearchParams(destination.split('?')[1]).get('explain')!)).toEqual({ kind: 'group', collection: 'sentCv', key, isMissing: false });
      }
    } finally { await h.close(); }
  });
  it('keeps known reference IDs explicit on metadata failure and retries without changing missing categories', async () => {
    let failed = true; const h = await mount({ data: referencesFixture(), metadata: async (path) => failed ? Response.json({}, { status: 503 }) : path.startsWith('/api/v1/resume-refs?') ? Response.json({ items: [{ id: id(80), label: '<CV React>' }, { id: id(81), label: null }], nextCursor: null }) : Response.json({ batch: { id: id(90), batchNumber: 7 } }) });
    try {
      expect(await screen.findByText(/Não foi possível carregar todos os rótulos/)).toBeInTheDocument();
      const cv = screen.getByRole('region', { name: 'Currículo efetivamente enviado' });
      expect(cv).toHaveTextContent('Metadados de CV indisponíveis'); expect(cv).toHaveTextContent(id(80));
      expect(within(cv).getAllByRole('rowheader', { name: 'Sem CV enviado informado' })).toHaveLength(1);
      failed = false; await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente os rótulos' }));
      expect(await within(cv).findByRole('rowheader', { name: '[1] <CV React>' })).toBeInTheDocument();
      expect(cv).toHaveTextContent('CV sem rótulo informado'); expect(cv.querySelector('CV')).toBeNull();
      await waitFor(() => expect(screen.queryByText(/Não foi possível carregar todos os rótulos/)).not.toBeInTheDocument());
    } finally { await h.close(); }
  });
  it('does not publish late display metadata after logout clears the owner-scoped cache', async () => {
    let release!: () => void; const held = new Promise<void>((done) => { release = done; });
    const h = await mount({ data: referencesFixture(), metadata: async (path) => { await held; return path.startsWith('/api/v1/resume-refs?') ? Response.json({ items: [{ id: id(80), label: 'Rótulo tardio' }, { id: id(81), label: 'Outro rótulo' }], nextCursor: null }) : Response.json({ batch: { id: id(90), batchNumber: 7 } }); } });
    try {
      await waitFor(() => expect(h.reads.some((path) => path.startsWith('/api/v1/resume-refs?'))).toBe(true));
      await h.runtime.auth.logout(); release(); await new Promise((done) => setTimeout(done, 0));
      expect(screen.queryByText('Rótulo tardio')).not.toBeInTheDocument();
      expect(h.runtime.query.getQueriesData({ queryKey: ['analytics-display-metadata'] }).every(([, value]) => value === undefined)).toBe(true);
    } finally { release(); await h.close(); }
  });
  it('keeps the displayed normalized query when returning from records and refreshes explicitly', async () => {
    const h = await mount({ routed: true });
    const region = await screen.findByRole('region', { name: 'Canal de descoberta' });
    await userEvent.click(within(region).getByRole('button', { name: 'Ver candidaturas: canal_desconhecido' }));
    expect(await screen.findByText('Lista explicativa')).toBeInTheDocument();
    const count = h.reads.length;
    await userEvent.click(screen.getByRole('button', { name: 'Voltar à análise' }));
    await screen.findByRole('region', { name: 'Canal de descoberta' });
    expect(h.reads).toHaveLength(count);
    await userEvent.click(screen.getByRole('button', { name: 'Atualizar análises' }));
    await waitFor(() => expect(h.reads.length).toBe(count + 1));
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar período' }));
    await waitFor(() => expect(h.reads.length).toBe(count + 2));
    await h.close();
  });
  it('uses each group conversion selector for equal counts with distinct API IDs', async () => {
    const data = fixture(); const group = data.groups.discoveryChannel.find((item) => !item.isMissing)!;
    group.conversions.assessment = { numerator: 1, denominator: 2, ratio: .5, applicationIds: [id(3)] };
    expect(group.conversions.response.applicationIds).toEqual([id(1)]);
    const h = await mount({ data }); const region = await screen.findByRole('region', { name: 'Canal de descoberta' });
    const row = within(region).getByRole('row', { name: /canal_desconhecido/ });
    await userEvent.click(within(row).getByText('Conversões deste grupo'));
    for (const [label, category, ids] of [['Retorno substantivo', 'response', [id(1)]], ['Avaliação', 'assessment', [id(3)]]] as const) {
      const button = within(row).getByRole('button', { name: `Ver candidaturas com ${label}: canal_desconhecido` });
      button.focus(); await userEvent.keyboard('{Enter}');
      const selection = JSON.parse(new URLSearchParams(screen.getByLabelText('Destino').textContent!.split('?')[1]).get('explain')!);
      expect(selection).toEqual({ kind: 'group', collection: 'discoveryChannel', key: group.key, isMissing: false, category });
      expect(group.conversions[selection.category as 'response' | 'assessment'].applicationIds).toEqual(ids);
    }
    await h.close();
  });
  it('preserves long domain labels and exact returned IDs in the shared bar/table selection', async () => {
    const data = fixture(); const group = data.groups.discoveryChannel.find((item) => !item.isMissing)!;
    const exactIds = [...group.applicationIds]; group.key = 'L'.repeat(300); group.label = group.key;
    const h = await mount({ data }); const region = await screen.findByRole('region', { name: 'Canal de descoberta' });
    await waitFor(() => expect(chart('Canal de descoberta')).toBeDefined());
    chart('Canal de descoberta').click({ seriesIndex: 0, dataIndex: data.groups.discoveryChannel.indexOf(group) });
    await waitFor(() => expect(screen.getByLabelText('Destino')).toHaveTextContent('/vagas?'));
    const destination = screen.getByLabelText('Destino').textContent!;
    await userEvent.click(within(region).getByRole('button', { name: `Ver candidaturas: ${group.label}` }));
    expect(screen.getByLabelText('Destino').textContent).toBe(destination);
    const selection = JSON.parse(new URLSearchParams(destination.split('?')[1]).get('explain')!);
    expect(selection).toEqual({ kind: 'group', collection: 'discoveryChannel', key: group.key, isMissing: false });
    expect(data.groups.discoveryChannel.find((item) => item.key === selection.key && item.isMissing === selection.isMissing)!.applicationIds).toEqual(exactIds);
    await h.close();
  });
  it('bar and keyboard table action preserve the same server query and structured missing identity', async () => {
    const h = await mount();
    const region = await screen.findByRole('region', { name: 'Canal de descoberta' });
    const missing = within(region).getByRole('row', { name: /Canal desconhecido/ });
    const literal = within(region).getByRole('row', { name: /canal_desconhecido/ });
    expect(literal).toHaveTextContent('2'); expect(missing).toHaveTextContent('1');
    await waitFor(() => expect(chart('Canal de descoberta')).toBeDefined());
    const groups = fixture().groups.discoveryChannel;
    chart('Canal de descoberta').click({ seriesIndex: 0, dataIndex: groups.findIndex((g) => g.isMissing) });
    await waitFor(() => expect(screen.getByLabelText('Destino')).toHaveTextContent('/vagas?'));
    const bar = screen.getByLabelText('Destino').textContent!;
    const button = within(missing).getByRole('button', { name: 'Ver candidaturas: Canal desconhecido' }); button.focus(); await userEvent.keyboard('{Enter}');
    expect(screen.getByLabelText('Destino').textContent).toBe(bar);
    const params = new URLSearchParams(bar.split('?')[1]);
    expect(JSON.parse(params.get('query')!)).toEqual(fixture().query);
    expect(JSON.parse(params.get('explain')!)).toEqual({ kind: 'group', collection: 'discoveryChannel', key: 'canal_desconhecido', isMissing: true });
    await userEvent.click(within(literal).getByRole('button', { name: 'Ver candidaturas: canal_desconhecido' }));
    expect(JSON.parse(new URLSearchParams(screen.getByLabelText('Destino').textContent!.split('?')[1]).get('explain')!).isMissing).toBe(false);
    await h.close();
  });
  it('routes completed and period event category counts to their distinct exact API sets', async () => {
    const data = fixture(false, true); const h = await mount({ data });
    expect(data.conversions.interview.applicationIds).toEqual([id(1)]);
    expect(data.completed.interview.applicationIds).toEqual([id(1)]);
    expect(data.eventsInPeriod.categories.interview.applicationIds).toEqual([id(2)]);
    for (const [title, kind] of [['Etapas concluídas', 'completed'], ['Categorias de acontecimentos', 'eventsCategory']] as const) {
      const region = await screen.findByRole('region', { name: title });
      const button = within(region).getByRole('button', { name: 'Ver candidaturas: Entrevista' });
      button.focus(); await userEvent.keyboard('{Enter}');
      const params = new URLSearchParams(screen.getByLabelText('Destino').textContent!.split('?')[1]);
      expect(JSON.parse(params.get('explain')!)).toEqual({ kind, category: 'interview' });
      await waitFor(() => expect(chart(title)).toBeDefined());
      chart(title).click({ seriesIndex: 0, dataIndex: 2 });
      expect(new URLSearchParams(screen.getByLabelText('Destino').textContent!.split('?')[1]).get('explain')).toBe(params.get('explain'));
    }
    await h.close();
  });
  it('shows server populations, goals, N/D, coverage, missing CV and excluded first returns', async () => {
    const h = await mount();
    const coverage = await screen.findByRole('region', { name: 'Cobertura dos dados' });
    expect(coverage).toHaveTextContent('Sem dia exato de envio'); expect(coverage).toHaveTextContent('Aproximada'); expect(coverage).toHaveTextContent('Desconhecida');
    expect(await screen.findByRole('region', { name: 'Currículo efetivamente enviado' })).toHaveTextContent('Sem CV enviado informado');
    const returns = screen.getByRole('region', { name: 'Primeiro retorno substantivo' });
    expect(returns).toHaveTextContent('1 dia'); expect(returns).toHaveTextContent('1 elegível'); expect(returns).toHaveTextContent('Envio sem dia exato');
    expect(screen.getByRole('region', { name: 'Categorias atingidas' })).toHaveTextContent('1 / 3');
    expect(screen.getByRole('region', { name: 'Envios por dia' })).toHaveTextContent('Meta');
    expect(screen.getByRole('region', { name: 'Stack informada' })).toHaveTextContent('Grupos podem se sobrepor');
    expect(screen.getByRole('region', { name: 'Acontecimentos no período' })).toHaveTextContent('Não acrescentam novos envios');
    await h.close();
  });
  it('labels the occurrence-date denominator in events and opens the matching application list', async () => {
    const data = fixture();
    const h = await mount({ data });
    const coverage = await screen.findByRole('region', { name: 'Data de ocorrência dos eventos' });
    const exact = within(coverage).getByRole('row', { name: /^Dia exato de ocorrência/ });
    expect(within(exact).getByRole('cell', { name: '1 / 1 evento' })).toBeVisible();
    await userEvent.click(within(exact).getByRole('button', { name: 'Ver candidaturas: Dia exato de ocorrência' }));
    const params = new URLSearchParams(screen.getByLabelText('Destino').textContent!.split('?')[1]);
    expect(JSON.parse(params.get('explain')!)).toEqual({ kind: 'occurrenceDateCoverage', bucket: 'exactDay', selectionKey: occurrenceDateDrilldown.exactDay });
    expect(JSON.parse(params.get('query')!)).toEqual(data.query);
    await h.close();
  });
  it('recalculates a stale occurrence selection with the same normalized filter and a new cutoff', async () => {
    const original = { ...query, filters: { company: ['Fictícia'] }, dimension: 'company' };
    const parameters = new URLSearchParams({ query: JSON.stringify(original), explain: JSON.stringify({ kind: 'occurrenceDateCoverage', bucket: 'exactDay', selectionKey: 'a'.repeat(64) }) });
    const h = await mount({
      routed: true, initialDrilldown: `/vagas?${parameters}`,
      metadata: async () => Response.json({ error: { code: 'ANALYTICS_SELECTION_STALE' } }, { status: 409 }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('A lista mudou desde o cálculo desta análise.');
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Recalcular análise' }));
    await screen.findByRole('region', { name: 'Data de ocorrência dos eventos' });
    const read = h.reads.find((path) => path.startsWith('/api/v1/analytics?'))!;
    const outgoing = JSON.parse(new URL(read, 'http://localhost').searchParams.get('query')!);
    expect(outgoing).toEqual({
      operation: 'metrics', period: original.period, population: original.population, dimension: 'company',
      submissionScope: original.submissionScope, filters: original.filters,
    });
    await h.close();
  });
  it('null ratio and null median are sem dados and N/D, never a zero conversion', async () => {
    const h = await mount({ empty: true });
    const categories = await screen.findByRole('region', { name: 'Categorias atingidas' });
    expect(categories).toHaveTextContent('sem dados'); expect(categories).toHaveTextContent('0 / 0'); expect(categories).not.toHaveTextContent('0%');
    expect(screen.getByRole('region', { name: 'Primeiro retorno substantivo' })).toHaveTextContent('N/D');
    expect(screen.getByText(/Registre sua primeira candidatura/)).toBeInTheDocument(); await h.close();
  });
  it('backend failure offers retry and never renders an empty success', async () => {
    const h = await mount({ failed: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as análises');
    expect(screen.queryByRole('region', { name: 'Envios por dia' })).not.toBeInTheDocument();
    h.retry(); await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('region', { name: 'Envios por dia' })).toBeInTheDocument(); await h.close();
  });
  it('keeps untrusted labels as text and disables HTML tooltips', async () => {
    const h = await mount();
    const platform = await screen.findByRole('region', { name: 'Plataforma de envio' });
    expect(platform).toHaveTextContent('<img src=x onerror=alert(1)>'); expect(platform.querySelector('img')).toBeNull();
    await waitFor(() => expect(chart('Plataforma de envio')).toBeDefined());
    expect(chart('Plataforma de envio').option).not.toHaveProperty('tooltip');
    const option = chart('Plataforma de envio').option;
    expect(option).toMatchObject({ animation: false, aria: { enabled: true, decal: { show: true }, label: { description: expect.stringContaining('Plataforma de envio') } } });
    await h.close();
  });
  it('resizes, removes motion and chart listeners, disconnects observers and disposes every instance', async () => {
    const h = await mount(); await screen.findByRole('region', { name: 'Envios por dia' });
    await waitFor(() => expect(engine.instances.length).toBeGreaterThan(5));
    const instances = [...engine.instances]; const owned = [...observers];
    owned[0]!.callback([], {} as ResizeObserver); expect(instances[0]!.resize).toHaveBeenCalled();
    await h.close();
    for (const instance of instances) { expect(instance.dispose).toHaveBeenCalledTimes(1); expect(instance.off).toHaveBeenCalledWith('click', expect.any(Function)); }
    for (const observer of owned) expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(motion.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
