// @vitest-environment jsdom
import '../../src/app/validation';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Link, MemoryRouter } from 'react-router';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { App } from '../../src/app/App';
import { createAppRuntime } from '../../src/app/runtime';
import type { AuthPort } from '../../src/lib/auth';
import type { Command } from '../../shared/commands';

afterEach(cleanup);
const owner = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const opportunityId = '33333333-3333-4333-8333-333333333333';
const unknown = { precision: 'unknown', value: null };
function application() { return { id, version: 1, displayId: 'N000001', submissionStatus: 'confirmado', submittedDate: unknown, stage: 'desconhecida', countingEligible: true, canonicalApplicationId: null, archivedAt: null, cycleRelation: 'unknown', cycleOrder: null, stack: [], discoveryChannel: null, submissionPlatform: null, resumeIds: [], track: 'AI Builder', applicationInstance: 'initial', notes: null, eventIds: [], historyApplicationIds: [id], opportunity: { id: opportunityId, version: 1, company: 'Empresa Fictícia', title: 'Engenharia', platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'vaga', seniority: null, modality: null, description: null, stack: [] } }; }
async function mount(path = '/vagas/nova', fail: boolean | 'network' = false, status = 'confirmado', pagination?: { destination: string; respond(url: URL): Response }) {
  let callback!: (event: AuthChangeEvent, session: Session | null) => void;
  const session = { access_token: 'synthetic', user: { id: owner } } as Session;
  let failed = fail;
  let conflict = false; let similar = false;
  let rejection: { status: number; code: string } | null = null; let readFailure = false;
  const resumes: { id: string; label: string }[] = [];
  let heldRead: Promise<void> | null = null;
  let heldWrite: Promise<void> | null = null;
  const writes: { body: Command; key: string }[] = [];
  const reads: string[] = [];
  const current = application();
  current.submissionStatus = status;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input); reads.push(url);
    if (heldRead && (url.startsWith('/api/v1/batches') || url === `/api/v1/applications/${id}` || url.startsWith('/api/v1/applications?'))) await heldRead;
    if (url.endsWith('/health')) return Response.json({ status: 'ok' });
    if (url.startsWith('/api/v1/resume-refs')) return Response.json({ items: resumes, total: resumes.length, nextCursor: null });
    if (url.startsWith('/api/v1/batches')) return readFailure ? Response.json({ error: {} }, { status: 503 }) : Response.json({ state: 'not_started', cycleId: null, items: [] });
    if (url === `/api/v1/applications/${id}`) return readFailure ? Response.json({ error: {} }, { status: 503 }) : Response.json({ application: current, links: [], resumeRefs: [], tasks: [], affectedBatches: [] });
    if (url.startsWith('/api/v1/applications?')) return pagination?.respond(new URL(url, 'http://localhost')) ?? Response.json({ items: path === '/vagas/nova' && !similar ? [] : [current], total: path === '/vagas/nova' && !similar ? 0 : 1, nextCursor: null });
    if (url.endsWith('/commands')) {
      const body = JSON.parse(init!.body as string) as Command;
      writes.push({ body, key: (init!.headers as Record<string, string>)['Idempotency-Key']! });
      if (heldWrite) await heldWrite;
      if (rejection) { const rejected = rejection; rejection = null; return Response.json({ error: { code: rejected.code } }, { status: rejected.status }); }
      if (conflict) { conflict = false; return Response.json({ error: { code: 'CONFLICT', details: { currentVersion: current.version, changedFields: [] } } }, { status: 409 }); }
      if (failed === 'network') throw new TypeError('Fixture connection lost');
      if (failed) return Response.json({ error: {} }, { status: 503 });
      if (url.endsWith('/commands') && body.operation === 'update_application' && body.changes.stage && current.stage !== body.changes.stage) {
        Object.assign(current, { stage: body.changes.stage, version: current.version + 1 });
      }
      return Response.json({ application: current, resumeRef: null, existing: false, warnings: [], eligibilityChanges: [], affectedBatches: [], allocationPending: false });
    }
    return Response.json({}, { status: 404 });
  };
  const port: AuthPort = { onAuthStateChange: (listener) => { callback = listener; queueMicrotask(() => callback('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; }, signInWithPassword: async () => { callback('SIGNED_IN', session); return { error: null }; }, resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }), signOut: async () => ({ error: null }) };
  const runtime = createAppRuntime(port, transport);
  const view = render(<MemoryRouter initialEntries={[path]}>{pagination && <Link to={pagination.destination}>Outra seleção</Link>}<App runtime={runtime} /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Vagas' });
  const holdWrite = () => {
    let release!: () => void;
    heldWrite = new Promise<void>(resolve => { release = resolve; });
    return () => { heldWrite = null; release(); };
  };
  return { runtime, writes, reads, current, holdWrite, holdRead: () => { let release!: () => void; heldRead = new Promise<void>((resolve) => { release = resolve; }); return () => { heldRead = null; release(); }; }, reject: (status: number, code: string) => { rejection = { status, code }; }, failRead: (value: boolean) => { readFailure = value; }, addResume: async () => { resumes.push({ id: opportunityId, label: 'CV fictício' }); await act(() => runtime.query.invalidateQueries({ queryKey: ['resume-refs'] })); }, conflict: () => { conflict = true; }, similar: () => { similar = true; }, retry: () => { failed = false; }, expire: () => act(() => runtime.auth.expire()), reenter: () => act(() => callback('SIGNED_IN', session)), close: async () => { view.unmount(); await runtime.dispose(); } };
}

describe('application form through guarded runtime (synthetic HTTP/Auth)', () => {
  it('retains exact uncertain application replay after a saved-view read discovers an alias', async () => {
    const h = await mount(`/vagas/${id}/editar`, true);
    try {
      fireEvent.change(await screen.findByLabelText('Observações'), { target: { value: 'Intenção sem resposta confirmada' } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' })); await screen.findByRole('button', { name: 'Repetir gravação original' });
      Object.assign(h.current, { version: 2, canonicalApplicationId: opportunityId });
      await act(() => h.runtime.query.invalidateQueries({ queryKey: ['application-edit'] }));
      expect(screen.getByLabelText('Observações')).toHaveValue('Intenção sem resposta confirmada'); h.retry();
      fireEvent.click(screen.getByRole('button', { name: 'Repetir gravação original' })); await screen.findByText('Registro salvo.');
      expect(h.writes).toHaveLength(2); expect(h.writes[1]).toEqual(h.writes[0]);
    } finally { await h.close(); }
  });
  it('keeps an open draft visible when a conflict reread discovers its application became an alias', async () => {
    const h = await mount(`/vagas/${id}/editar`);
    try {
      fireEvent.change(await screen.findByLabelText('Observações'), { target: { value: 'Minha intenção anterior à união' } });
      Object.assign(h.current, { version: 2, canonicalApplicationId: opportunityId }); h.conflict();
      fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
      const dialog = await screen.findByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Reler versão atual' }));
      expect(await within(dialog).findByRole('link', { name: 'Abrir edição do registro canônico' })).toHaveAttribute('href', `/vagas/${opportunityId}/editar`);
      within(dialog).getByRole('button', { name: 'Fechar e manter edição' }).focus(); fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(within(dialog).getByRole('link', { name: 'Abrir edição do registro canônico' })).toHaveFocus();
      expect(within(dialog).getByRole('button', { name: 'Reaplicar campos selecionados' })).toBeDisabled();
      expect(dialog).toHaveTextContent('Minha intenção anterior à união');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar e manter edição' }));
      expect(screen.getByLabelText('Observações')).toHaveValue('Minha intenção anterior à união'); expect(screen.getByLabelText('Observações')).toBeDisabled();
      expect(h.writes).toHaveLength(1); expect(h.writes[0]!.body).toMatchObject({ application: { id, expectedVersion: 1 }, changes: { notes: 'Minha intenção anterior à união' } });
      h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.reenter();
      expect(await screen.findByLabelText('Observações')).toHaveValue('Minha intenção anterior à união'); expect(h.writes).toHaveLength(1);
    } finally { await h.close(); }
  });
  it('allows retry after a corrective reread finishes while the same owner is logged out', async () => {
    const h = await mount(); let release = () => {};
    try {
      fireEvent.change(await screen.findByLabelText('Relato ou evidência'), { target: { value: 'Envio fictício.' } });
      h.reject(400, 'INVALID_INPUT'); fireEvent.click(screen.getByText('Registrar candidatura', { selector: 'button' }));
      await screen.findByText('Revisar registro recusado'); release = h.holdRead(); fireEvent.click(screen.getByText('Revisar registro recusado'));
      h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); }); h.reenter();
      expect(await screen.findByText('Revisar registro recusado')).toBeEnabled();
      fireEvent.click(screen.getByText('Revisar registro recusado')); await screen.findByText('Preparar intenção corrigida'); expect(h.writes).toHaveLength(1);
    } finally { release(); await h.close(); }
  });
  it('requires another authorized reread if login expires during rejected-input revision', async () => {
    const h = await mount();
    try {
      fireEvent.change(await screen.findByLabelText('Relato ou evidência'), { target: { value: 'Envio fictício.' } });
      h.reject(400, 'INVALID_INPUT'); fireEvent.click(screen.getByText('Registrar candidatura', { selector: 'button' }));
      fireEvent.click(await screen.findByText('Revisar registro recusado'));
      await screen.findByText('Preparar intenção corrigida');
      fireEvent.change(screen.getByLabelText('Precisão'), { target: { value: 'day' } });
      fireEvent.change(screen.getByLabelText('Certeza'), { target: { value: 'approximate' } });
      fireEvent.change(screen.getByLabelText('Dia, mês e ano'), { target: { value: '2026-11-' } });
      h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.reenter();
      fireEvent.click(await screen.findByText('Revisar registro recusado'));
      await screen.findByText('Preparar intenção corrigida');
      expect(screen.getByLabelText('Dia, mês e ano')).toHaveValue('2026-11-');
      expect(screen.getByText('Preparar intenção corrigida')).toBeDisabled(); expect(h.writes).toHaveLength(1);
    } finally { await h.close(); }
  });
  it('checks newly corrected identity for possible duplicates before preparing a replacement intention', async () => {
    const h = await mount();
    try {
      fireEvent.change(await screen.findByLabelText('Relato ou evidência'), { target: { value: 'Outra trilha fictícia.' } });
      h.reject(400, 'INVALID_INPUT'); fireEvent.click(screen.getByText('Registrar candidatura', { selector: 'button' }));
      fireEvent.click(await screen.findByText('Revisar registro recusado')); await screen.findByText('Preparar intenção corrigida');
      h.similar(); fireEvent.change(screen.getByLabelText('Empresa'), { target: { value: 'Empresa Fictícia' } }); fireEvent.change(screen.getByLabelText('Cargo'), { target: { value: 'Engenharia' } });
      fireEvent.click(screen.getByText('Preparar intenção corrigida'));
      await screen.findByText('Confira antes de registrar'); expect(h.writes).toHaveLength(1);
      fireEvent.click(screen.getByText('Registrar como candidatura distinta com evidência'));
      await screen.findByText('Salvar intenção revisada'); expect(h.writes).toHaveLength(1);
    } finally { await h.close(); }
  });
  it.each([false, true])('preserves independent raw draft and original versions after action refresh (read failure: %s)', async (readFailure) => {
    const h = await mount(`/vagas/${id}/editar`);
    try {
      fireEvent.change(await screen.findByLabelText('Observações'), { target: { value: 'Nota ainda não salva' } });
      await h.addResume(); await screen.findByText('CV fictício', { exact: true }); fireEvent.change(screen.getByLabelText('Currículo efetivamente enviado'), { target: { value: opportunityId } });
      fireEvent.change(screen.getByLabelText('Precisão'), { target: { value: 'day' } }); fireEvent.change(screen.getByLabelText('Certeza'), { target: { value: 'approximate' } });
      fireEvent.change(screen.getByLabelText('Dia, mês e ano'), { target: { value: '2026-11-' } });
      fireEvent.click(screen.getByText('Arquivar registro', { exact: true }));
      fireEvent.click(await screen.findByText('Confirmar arquivamento', { exact: true }));
      await screen.findByText('Decisão salva.', { exact: false });
      Object.assign(h.current, { version: 2, archivedAt: '2026-11-17T12:00:00Z' }); Object.assign(h.current.opportunity, { version: 5, company: 'Empresa alterada remotamente' });
      h.failRead(readFailure);
      fireEvent.click(screen.getByText('Atualizar registro', { exact: true, selector: 'button' }));
      if (readFailure) { await screen.findByText(/Não foi possível atualizar o registro salvo/); h.failRead(false); }
      expect(screen.getByLabelText('Observações')).toHaveValue('Nota ainda não salva');
      expect(screen.getByLabelText('Dia, mês e ano')).toHaveValue('2026-11-');
      expect(screen.getByLabelText('Currículo efetivamente enviado')).toHaveValue([opportunityId]);
      if (readFailure) fireEvent.click(screen.getByText('Atualizar registro', { exact: true, selector: 'button' }));
      await screen.findByText('Restaurar registro', { exact: true });
      expect(screen.getByLabelText('Empresa')).toHaveValue('Empresa Fictícia');
      fireEvent.change(screen.getByLabelText('Dia, mês e ano'), { target: { value: '2026-11-17' } });
      fireEvent.change(screen.getByLabelText('Relato ou evidência'), { target: { value: 'Confirmei a data.' } });
      h.conflict(); fireEvent.click(screen.getByText('Salvar alterações', { exact: true }));
      expect(h.writes[1]!.body).toMatchObject({ application: { id, expectedVersion: 1 } });
      expect(h.writes[1]!.body).not.toHaveProperty('opportunityPatch');
      await screen.findByRole('dialog');
    } finally { await h.close(); }
  });
  it.each(['new400', 'edit400', 'new409'])('explicitly rereads and corrects a rejected intention: %s', async (kind) => {
    const h = await mount(kind === 'edit400' ? `/vagas/${id}/editar` : '/vagas/nova');
    try {
      fireEvent.change(await screen.findByLabelText('Observações'), { target: { value: 'Texto retido' } });
      fireEvent.change(screen.getByLabelText('Relato ou evidência'), { target: { value: 'Envio fictício relatado.' } });
      if (kind === 'new409') await userEvent.selectOptions(screen.getByLabelText('Relação com o ciclo'), 'after_reset');
      else fireEvent.change(screen.getByLabelText(kind === 'edit400' ? 'Novos links (um por linha)' : 'Link original e alternativos (um por linha)'), { target: { value: 'https://user:fictional@example.invalid' } });
      h.reject(kind === 'new409' ? 409 : 400, kind === 'new409' ? 'CYCLE_NOT_STARTED' : 'INVALID_INPUT');
      await userEvent.click(screen.getByRole('button', { name: kind === 'edit400' ? 'Salvar alterações' : 'Registrar candidatura' }));
      await screen.findByRole('button', { name: 'Revisar registro recusado' });
      expect(screen.getByLabelText('Observações')).toBeDisabled();
      h.failRead(true); await userEvent.click(screen.getByRole('button', { name: 'Revisar registro recusado' }));
      await screen.findByText(/Não foi possível reler para revisar/);
      expect(screen.getByLabelText('Observações')).toHaveValue('Texto retido'); expect(screen.getByLabelText('Observações')).toBeDisabled();
      if (kind === 'edit400') { h.current.version = 3; Object.assign(h.current.opportunity, { version: 7, company: 'Empresa remota' }); }
      h.failRead(false); await userEvent.click(screen.getByRole('button', { name: 'Revisar registro recusado' }));
      await screen.findByRole('button', { name: 'Preparar intenção corrigida' });
      expect(screen.getByLabelText('Observações')).toBeEnabled(); expect(h.writes).toHaveLength(1);
      if (kind === 'new409') { expect(screen.getByLabelText('Relação com o ciclo')).toHaveValue('after_reset'); await userEvent.selectOptions(screen.getByLabelText('Relação com o ciclo'), 'unknown'); }
      else { const link = screen.getByLabelText(kind === 'edit400' ? 'Novos links (um por linha)' : 'Link original e alternativos (um por linha)'); fireEvent.change(link, { target: { value: 'https://example.invalid' } }); }
      await userEvent.click(screen.getByRole('button', { name: 'Preparar intenção corrigida' }));
      if (kind === 'edit400') { const dialog = await screen.findByRole('dialog'); for (const label of ['Novos links', 'Observações']) await userEvent.click(within(dialog).getByRole('checkbox', { name: `Reaplicar ${label}` })); await userEvent.click(within(dialog).getByRole('button', { name: 'Reaplicar campos selecionados' })); }
      expect(h.writes).toHaveLength(1);
      await userEvent.click(screen.getByRole('button', { name: 'Salvar intenção revisada' })); await screen.findByText('Registro salvo.');
      expect(h.writes).toHaveLength(2); expect(h.writes[1]!.key).not.toBe(h.writes[0]!.key);
      if (kind === 'edit400') { expect(h.writes[1]!.body).toMatchObject({ application: { expectedVersion: 3 }, changes: { notes: 'Texto retido' } }); expect(h.writes[1]!.body).not.toHaveProperty('opportunityPatch'); }
      else expect(h.writes[1]!.body).toMatchObject({ data: { notes: 'Texto retido', cycleRelation: 'unknown' } });
    } finally { await h.close(); }
  });
  it.each(['general', 'ids', 'query', 'explain'])('resets pagination before requesting a changed population: %s', async (transition) => {
    const first = new URLSearchParams({ ids: JSON.stringify([id]) });
    const destination = transition === 'general' ? '/vagas' : transition === 'ids'
      ? `/vagas?${new URLSearchParams({ ids: JSON.stringify([opportunityId]) })}`
      : `/vagas?${new URLSearchParams({ query: JSON.stringify({ period: transition === 'query' ? 'new' : 'initial' }), explain: JSON.stringify({ kind: 'population', name: transition === 'explain' ? 'cycle' : 'selected' }) })}`;
    const initial = ['query', 'explain'].includes(transition)
      ? `/vagas?${new URLSearchParams({ query: JSON.stringify({ period: 'initial' }), explain: JSON.stringify({ kind: 'population', name: 'selected' }) })}`
      : `/vagas?${first}`;
    const populationRequests: URL[] = [];
    const h = await mount(initial, false, 'confirmado', { destination, respond: (url) => {
      populationRequests.push(url);
      const scope = ['ids', 'query', 'explain'].map((key) => url.searchParams.get(key) ?? '').join('|');
      const cursor = url.searchParams.get('cursor');
      if (cursor && cursor !== `next:${scope}`) return Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 400 });
      return Response.json({ items: [{ ...application(), displayId: cursor ? 'PAGE_TWO' : 'PAGE_ONE' }], total: 21, nextCursor: cursor ? null : `next:${scope}` });
    } });
    try {
      await screen.findByText('Página 1');
      await userEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
      await screen.findByText('Página 2');
      const boundary = populationRequests.length;
      await userEvent.click(screen.getByRole('link', { name: transition === 'general' ? 'Abrir lista geral' : 'Outra seleção' }));
      expect(populationRequests[boundary]!.searchParams.has('cursor')).toBe(false);
      await screen.findByText('Página 1');
      expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
      expect(within(screen.getByRole('table')).getByText(/PAGE_ONE/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
      await screen.findByText('Página 2');
      expect(within(screen.getByRole('table')).getByText(/PAGE_TWO/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Página anterior' }));
      await screen.findByText('Página 1');
      expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
      expect(populationRequests.slice(boundary).every((url) => !url.searchParams.has('cursor') || url.searchParams.get('cursor') === `next:${['ids', 'query', 'explain'].map((key) => url.searchParams.get(key) ?? '').join('|')}`)).toBe(true);
    } finally { await h.close(); }
  });
  it('records a confirmed application first with explicit track and unknown date/CV/stage/cycle', async () => {
    const h = await mount();
    expect(await screen.findByText(/Registrar não envia/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Empresa'), 'Empresa Fictícia');
    await userEvent.type(screen.getByLabelText('Cargo'), 'Engenharia');
    await userEvent.type(screen.getByLabelText('Trilha'), 'AI Builder');
    await userEvent.type(screen.getByLabelText('Relato ou evidência'), 'Eu enviei este currículo.');
    await userEvent.click(screen.getByRole('button', { name: 'Registrar candidatura' }));
    await screen.findByText('Registro salvo.');
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.body).toMatchObject({ operation: 'save_application', data: { submissionStatus: 'confirmado', track: 'AI Builder', submittedDate: unknown, resumeIds: [], stage: 'desconhecida', cycleRelation: 'unknown' }, evidence: { kind: 'relato_usuario', originalText: 'Eu enviei este currículo.' } });
    await userEvent.click(screen.getByRole('button', { name: 'Registrar outra candidatura' }));
    expect(await screen.findByLabelText('Empresa')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Registrar candidatura' })).toBeEnabled();
    await h.close();
  });
  it.each(['2026-11-', '2026-02-30'])('retains raw invalid date %s through same-owner expiration and blocks the prior valid date', async (raw) => {
    const h = await mount();
    try {
    fireEvent.change(await screen.findByLabelText('Empresa'), { target: { value: 'Texto incompleto' } });
    await userEvent.selectOptions(screen.getByLabelText('Precisão'), 'day');
    await userEvent.selectOptions(screen.getByLabelText('Certeza'), 'exact');
    fireEvent.change(screen.getByLabelText('Dia, mês e ano'), { target: { value: '2026-11-15' } });
    fireEvent.change(screen.getByLabelText('Dia, mês e ano'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Dia, mês e ano'), { target: { value: raw } });
    h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.reenter();
    expect(await screen.findByLabelText('Dia, mês e ano')).toHaveValue(raw);
    fireEvent.change(screen.getByLabelText('Cargo'), { target: { value: 'Outra edição' } });
    expect(screen.getByLabelText('Dia, mês e ano')).toHaveValue(raw);
    expect(screen.getByLabelText('Empresa')).toHaveValue('Texto incompleto');
    await userEvent.click(screen.getByRole('button', { name: 'Registrar candidatura' }));
    expect(h.writes).toHaveLength(0);
    } finally { await h.close(); }
  });
  it('retries an uncertain save with the exact original key and payload', async () => {
    const h = await mount('/vagas/nova', true);
    await userEvent.type(await screen.findByLabelText('Relato ou evidência'), 'Envio relatado.');
    await userEvent.click(screen.getByRole('button', { name: 'Registrar candidatura' }));
    await screen.findByText(/Serviço indisponível/);
    h.retry(); await userEvent.click(screen.getByRole('button', { name: 'Repetir gravação original' }));
    await screen.findByText('Registro salvo.');
    expect(h.writes).toHaveLength(2); expect(h.writes[1]).toEqual(h.writes[0]);
    await h.close();
  });
  it('submits metadata-only correction with both application and opportunity versions', async () => {
    const h = await mount(`/vagas/${id}/editar`);
    await userEvent.type(await screen.findByLabelText('Senioridade'), 'Pleno');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await screen.findByText('Registro salvo.');
    expect(h.writes[0]!.body).toMatchObject({ operation: 'update_application', application: { id, expectedVersion: 1 }, changes: {}, opportunityPatch: { opportunity: { id: opportunityId, expectedVersion: 1 }, changes: { seniority: 'Pleno' } } });
    await h.close();
  });
  it('offers new actual CV metadata creation on an empty installation', async () => {
    const h = await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Adicionar referência de currículo' }));
    await userEvent.type(screen.getByLabelText('Nome do currículo'), 'CV Engenharia — novembro');
    await userEvent.click(screen.getByRole('button', { name: 'Criar referência' }));
    expect(h.writes[0]!.body).toMatchObject({ operation: 'create_resume_ref', data: { label: 'CV Engenharia — novembro', stack: [], language: null, localRef: null } });
    await h.close();
  });
  it('uses normalized server filters and provides accessible board stage movement', async () => {
    const h = await mount('/vagas');
    await screen.findByRole('table', { name: 'Candidaturas' });
    await userEvent.type(screen.getByLabelText('Filtrar empresa'), 'Empresa Fictícia');
    await userEvent.selectOptions(screen.getByLabelText('Arquivadas'), 'include');
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }));
    const url = new URL(h.reads.filter((p) => p.startsWith('/api/v1/applications?')).at(-1)!, 'http://localhost');
    expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({ company: ['Empresa Fictícia'], archived: 'include' });
    await userEvent.click(screen.getByRole('button', { name: 'Quadro' }));
    const board = await screen.findByRole('region', { name: 'Quadro por etapa' });
    await userEvent.selectOptions(within(board).getByLabelText('Etapa de N000001'), 'entrevista');
    await userEvent.click(within(board).getByRole('button', { name: 'Mover N000001' }));
    expect(h.writes[0]!.body).toEqual({ operation: 'update_application', application: { id, expectedVersion: 1 }, changes: { stage: 'entrevista' }, affectedBatches: [] });
    await h.close();
  });
  it('loads all submission statuses through every board cursor without changing the table population', async () => {
    const sample = Array.from({ length: 121 }, (_, index) => ({
      ...application(), id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, displayId: `V${index + 1}`,
      submissionStatus: index < 20 ? 'confirmado' : index % 2 ? 'nao_enviado' : 'nao_confirmado',
      opportunity: { ...application().opportunity, company: `Empresa ${index + 1}` },
    }));
    const h = await mount('/vagas', false, 'confirmado', {
      destination: '/vagas',
      respond(url) {
        const all = url.searchParams.get('view') === 'all';
        const page = url.searchParams.has('cursor') ? sample.slice(100) : sample.slice(0, all ? 100 : 20);
        return Response.json({ items: page, total: all ? 121 : 20, nextCursor: all && page.length === 100 ? 'second-page' : null });
      },
    });
    try {
      await screen.findByRole('table', { name: 'Candidaturas' });
      await userEvent.click(screen.getByRole('button', { name: 'Quadro' }));
      const board = await screen.findByRole('region', { name: 'Quadro por etapa' });
      expect(within(board).getAllByRole('article')).toHaveLength(121);
      expect(within(board).getByRole('link', { name: 'Empresa 121 · Engenharia' })).toBeVisible();
      expect(screen.queryByRole('navigation', { name: 'Páginas de candidaturas' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Tabela' }));
      expect(await screen.findByText('20 registro(s) no filtro · 20 nesta página')).toBeVisible();
      expect(h.reads.filter((url) => url.includes('cursor=second-page'))).toHaveLength(1);
    } finally { await h.close(); }
  });
  it('moves a dragged card after saving its stage and ignores canceled drag gestures', async () => {
    const h = await mount('/vagas');
    try {
      await screen.findByRole('table', { name: 'Candidaturas' });
      await userEvent.click(screen.getByRole('button', { name: 'Quadro' }));
      const board = await screen.findByRole('region', { name: 'Quadro por etapa' });
      const card = within(board).getByRole('article');
      const target = within(board).getByRole('region', { name: /^Entrevista/ });
      const dataTransfer = { setData() {}, dropEffect: 'none', effectAllowed: 'none' };
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.dragEnd(card, { dataTransfer });
      fireEvent.drop(target, { dataTransfer });
      expect(h.writes).toHaveLength(0);
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.dragOver(target, { dataTransfer });
      fireEvent.drop(target, { dataTransfer });
      expect(await within(target).findByRole('link', { name: 'Empresa Fictícia · Engenharia' })).toBeVisible();
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]!.body).toEqual({ operation: 'update_application', application: { id, expectedVersion: 1 }, changes: { stage: 'entrevista' }, affectedBatches: [] });
      expect(within(target).getByText('Envio confirmado')).toBeVisible();
    } finally { await h.close(); }
  });
  it('moves a dragged card before any response, rolls back after failure and retries the same request', async () => {
    const h = await mount('/vagas', 'network');
    let release = h.holdWrite();
    let releaseRead = () => {};
    try {
      await userEvent.click(await screen.findByRole('button', { name: 'Quadro' }));
      const board = await screen.findByRole('region', { name: 'Quadro por etapa' });
      const from = within(board).getByRole('region', { name: /^Etapa não informada/ });
      const to = within(board).getByRole('region', { name: /^Entrevista/ });
      const dataTransfer = { setData() {}, dropEffect: 'none', effectAllowed: 'none' };
      fireEvent.dragStart(within(from).getByRole('article'), { dataTransfer });
      fireEvent.dragOver(to, { dataTransfer });
      fireEvent.drop(to, { dataTransfer });
      expect(within(to).getByRole('link', { name: 'Empresa Fictícia · Engenharia' })).toBeVisible();
      expect(within(to).getByRole('status')).toHaveTextContent(/movendo|salvando/i);
      expect(within(from).queryByRole('article')).toBeNull();
      expect(h.current.stage).toBe('desconhecida');
      await act(async () => release());
      const retry = await within(from).findByRole('button', { name: 'Repetir movimento original' });
      expect(within(to).queryByRole('article')).toBeNull();
      h.retry();
      release = h.holdWrite();
      releaseRead = h.holdRead();
      fireEvent.click(retry);
      expect(within(to).getByRole('article')).toBeVisible();
      await act(async () => release());
      expect(await screen.findByText('Etapa registrada.', { exact: true })).toBeVisible();
      expect(within(to).getByRole('article')).toBeVisible();
      expect(h.writes).toHaveLength(2);
      expect(h.writes[1]).toEqual(h.writes[0]);
    } finally { release(); releaseRead(); await h.close(); }
  });
  it('refreshes the table if the move finishes after switching away from the board', async () => {
    const h = await mount('/vagas');
    const release = h.holdWrite();
    try {
      await userEvent.click(await screen.findByRole('button', { name: 'Quadro' }));
      await userEvent.selectOptions(await screen.findByLabelText('Etapa de N000001'), 'entrevista');
      await userEvent.click(screen.getByRole('button', { name: 'Mover N000001' }));
      await userEvent.click(screen.getByRole('button', { name: 'Tabela' }));
      const table = await screen.findByRole('table', { name: 'Candidaturas' });
      expect(within(table).getByText('Etapa não informada')).toBeVisible();
      await act(async () => release());
      expect(await within(table).findByText('Entrevista')).toBeVisible();
    } finally { release(); await h.close(); }
  });
  it('requires current preview and evidence before invalidating a counted submission', async () => {
    const h = await mount(`/vagas/${id}/editar`);
    await userEvent.click(await screen.findByRole('button', { name: 'Corrigir contagem ou duplicata' }));
    await userEvent.selectOptions(screen.getByLabelText('Correção'), 'invalidate_submission');
    await userEvent.type(screen.getByLabelText('Motivo da correção'), 'Envio registrado por engano');
    await userEvent.type(screen.getByLabelText('Evidência da correção'), 'Revisei e não houve envio.');
    expect(screen.queryByRole('button', { name: 'Confirmar correção' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Conferir impacto atual' }));
    await screen.findByText(/Histórico: 1 → 0/);
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar correção' }));
    expect(h.writes[0]!.body).toMatchObject({ operation: 'invalidate_submission', application: { id, expectedVersion: 1 }, affectedBatches: [], reason: 'Envio registrado por engano', evidence: { originalText: 'Revisei e não houve envio.' } });
    await h.close();
  });
  it('archives reversibly with no submission or task-completion command', async () => {
    const h = await mount(`/vagas/${id}/editar`);
    await userEvent.click(await screen.findByRole('button', { name: 'Arquivar registro' }));
    await screen.findByText(/Histórico: 1 → 1/);
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar arquivamento' }));
    expect(h.writes[0]!.body).toEqual({ operation: 'archive_application', application: { id, expectedVersion: 1 } });
    await h.close();
  });
  it('rereads conflict and reapplies only chosen metadata with all current nested versions and a new key', async () => {
    const h = await mount(`/vagas/${id}/editar`);
    await userEvent.type(await screen.findByLabelText('Senioridade'), 'Pleno');
    await userEvent.type(screen.getByLabelText('Observações'), 'Minha nota');
    h.current.version = 2; h.current.opportunity.version = 5; h.conflict();
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: 'Reaplicar Senioridade' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reler versão atual' }));
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: 'Reaplicar Senioridade' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reaplicar campos selecionados' }));
    expect(h.writes).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Salvar intenção revisada' }));
    await screen.findByText('Registro salvo.');
    expect(h.writes[1]!.body).toMatchObject({ operation: 'update_application', application: { id, expectedVersion: 2 }, changes: {}, opportunityPatch: { opportunity: { id: opportunityId, expectedVersion: 5 }, changes: { seniority: 'Pleno' } } });
    expect(h.writes[1]!.key).not.toBe(h.writes[0]!.key);
    await h.close();
  });
  it('shows possible duplicate reason before a deliberate distinct-record decision', async () => {
    const h = await mount(); h.similar();
    await userEvent.type(await screen.findByLabelText('Empresa'), 'Empresa Fictícia');
    await userEvent.type(screen.getByLabelText('Cargo'), 'Engenharia');
    await userEvent.type(screen.getByLabelText('Trilha'), 'AI Engineer');
    await userEvent.type(screen.getByLabelText('Relato ou evidência'), 'Envio para trilha diferente.');
    await userEvent.click(screen.getByRole('button', { name: 'Registrar candidatura' }));
    await screen.findByText(/Confira antes de registrar/);
    expect(h.writes).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Registrar como candidatura distinta com evidência' }));
    await screen.findByText('Registro salvo.');
    expect(h.writes[0]!.body).toMatchObject({ operation: 'save_application', data: { track: 'AI Engineer' } });
    await h.close();
  });
  it('requires evidence for deliberate track identity correction and preserves input when missing', async () => {
    const h = await mount(`/vagas/${id}/editar`);
    try {
    fireEvent.change(await screen.findByLabelText('Trilha'), { target: { value: 'Outra trilha' } });
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(h.writes).toHaveLength(0); expect(screen.getByLabelText('Trilha')).toHaveValue('Outra trilha');
    fireEvent.change(screen.getByLabelText('Relato ou evidência'), { target: { value: 'Corrigi a trilha com base no comprovante.' } });
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await screen.findByText('Registro salvo.');
    expect(h.writes[0]!.body).toMatchObject({ operation: 'update_application', changes: { track: 'Outra trilha' }, evidence: { originalText: 'Corrigi a trilha com base no comprovante.' } });
    } finally { await h.close(); }
  });
  it('retains an uncertain board intention across reauthentication even if the server version advanced', async () => {
    const h = await mount('/vagas', true);
    await screen.findByRole('table', { name: 'Candidaturas' }); await userEvent.click(screen.getByRole('button', { name: 'Quadro' }));
    await userEvent.selectOptions(screen.getByLabelText('Etapa de N000001'), 'entrevista'); await userEvent.click(screen.getByRole('button', { name: 'Mover N000001' }));
    await screen.findByText(/Serviço indisponível/);
    h.current.version = 2; h.current.stage = 'entrevista'; h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.reenter();
    await userEvent.click(await screen.findByRole('button', { name: 'Quadro' }));
    const dialog = await screen.findByRole('dialog'); await userEvent.click(within(dialog).getByRole('button', { name: 'Reler versão atual' }));
    h.retry(); await userEvent.click(await screen.findByRole('button', { name: 'Repetir movimento original' }));
    await screen.findByText('Etapa registrada.'); expect(h.writes).toHaveLength(2); expect(h.writes[1]).toEqual(h.writes[0]);
    await h.close();
  });
  it('does not apply hidden confirmation-date validity to a later archive decision', async () => {
    const h = await mount(`/vagas/${id}/editar`, false, 'nao_enviado');
    await userEvent.click(await screen.findByRole('button', { name: 'Confirmar envio realizado' }));
    const actions = screen.getByRole('region', { name: 'Ações do registro' });
    await userEvent.selectOptions(within(actions).getByLabelText('Precisão'), 'day');
    expect(within(actions).getByRole('button', { name: 'Conferir impacto atual' })).toBeDisabled();
    await userEvent.selectOptions(within(actions).getByLabelText('Correção'), 'archive_application');
    expect(within(actions).getByRole('button', { name: 'Conferir impacto atual' })).toBeEnabled();
    await userEvent.click(within(actions).getByRole('button', { name: 'Conferir impacto atual' }));
    await userEvent.click(await within(actions).findByRole('button', { name: 'Confirmar arquivamento' }));
    expect(h.writes[0]!.body).toEqual({ operation: 'archive_application', application: { id, expectedVersion: 1 } });
    await h.close();
  });
});
