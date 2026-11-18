// @vitest-environment jsdom
import '../../src/app/validation';
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { App } from '../../src/app/App';
import { createAppRuntime } from '../../src/app/runtime';
import type { AuthPort } from '../../src/lib/auth';

afterEach(cleanup);
function recoveryHarness(path: string, transport: typeof fetch) {
  const session = { access_token: 'synthetic', user: { id: '11111111-1111-4111-8111-111111111111' } } as Session;
  let callback!: (event: AuthChangeEvent, value: Session | null) => void;
  const port: AuthPort = { onAuthStateChange(listener) { callback = listener; queueMicrotask(() => callback('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; }, signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) };
  const runtime = createAppRuntime(port, transport);
  const mountView = () => render(<MemoryRouter initialEntries={[path]}><App runtime={runtime} /></MemoryRouter>);
  let view = mountView();
  return { runtime, expire: () => act(() => runtime.auth.expire()), reenter: () => act(() => callback('SIGNED_IN', session)), remount: () => { view.unmount(); view = mountView(); }, close: async () => { view.unmount(); await runtime.dispose(); } };
}
const id = '22222222-2222-4222-8222-222222222222';
function reviewRecovery(firstStatus: number, replayStatus = 200) {
  const originalId = '33333333-3333-4333-8333-333333333333'; const latestId = '44444444-4444-4444-8444-444444444444';
  const populationIds = Array.from({ length: 30 }, (_, index) => `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`);
  const snapshot = (numerator: number) => ({ metrics: { assessment: { numerator, denominator: 30, ratio: numerator / 30 } }, eligiblePopulationIds: populationIds, externalResultApplicationIds: [], externalResultEventIds: [], coverage: { missing: { role: { label: 'Cargo ausente', applicationIds: [populationIds[0]] } } } });
  const review = (reviewId: string, versionNumber: number, numerator: number) => ({ id: reviewId, versionNumber, predecessorId: versionNumber === 1 ? null : originalId, type: versionNumber === 1 ? 'original' : 'revision', narrative: `Saved version ${versionNumber}`, decisions: ['Current decision'], snapshot: snapshot(numerator), populationIds, closedAt: null, createdAt: '2026-11-17T12:00:00Z' });
  const original = review(originalId, 1, 1); const latest = review(latestId, 2, 3); const frozen = JSON.stringify({ original, latest });
  let closed = false; let readStatus = 200;
  const writes: { body: Record<string, unknown>; key: string | null }[] = [];
  const h = recoveryHarness(`/revisoes/${id}`, async (input, init) => {
    const path = String(input); const batch = { id, version: closed ? 3 : 1, batchNumber: 1, status: closed ? 'closed' : 'pending', target: 30 };
    if (path.endsWith('/health')) return Response.json({ status: 'ok' });
    if (path.startsWith('/api/v1/batches?')) return Response.json({ state: 'started', items: [batch], nextCursor: null });
    if (path.endsWith(`/batches/${id}`)) return readStatus !== 200 ? Response.json({}, { status: readStatus }) : Response.json({ batch, members: populationIds.map(applicationId => ({ applicationId })), versions: closed ? [original, latest].map(v => ({ id: v.id, versionNumber: v.versionNumber, type: v.type })) : [], preview: snapshot(0), rectificationPreview: snapshot(4) });
    if (path.endsWith(`/reviews/${originalId}`) || path.endsWith(`/reviews/${latestId}`)) return Response.json({ version: path.endsWith(latestId) ? latest : original, laterResults: [], externalResults: [] });
    if (path.endsWith('/commands')) {
      const body = JSON.parse(String(init?.body)); writes.push({ body, key: new Headers(init?.headers).get('Idempotency-Key') });
      if (body.operation === 'close_review') { const status = writes.length === 1 ? firstStatus : replayStatus; if (status !== 403) closed = true; return Response.json(status === 200 ? { saved: true } : { error: {} }, { status }); }
      return Response.json({ saved: true });
    }
    return Response.json({}, { status: 404 });
  });
  return { ...h, writes, originalId, latestId, populationIds, original, latest, frozen, readStatus: (value: number) => { readStatus = value; } };
}
async function submitClose() {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Análise' }), { target: { value: 'Retained local analysis' } });
  fireEvent.click(screen.getByLabelText('Conferi a população, o balanço e as lacunas'));
  fireEvent.click(screen.getByText('Confirmar fechamento'));
}
async function compareCurrent(version: number) {
  fireEvent.click(await screen.findByText('Comparar edição')); const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByText(`Versões atuais: ${version}`); return dialog;
}
async function mount(path: string) {
  const session = { access_token: 'synthetic', user: { id: '11111111-1111-4111-8111-111111111111' } } as Session;
  let callback!: (event: AuthChangeEvent, value: Session | null) => void;
  let fail = false; let readFail = false;
  const settings = { id, version: 1, dailyGoal: 5, timezone: 'America/Sao_Paulo' };
  const writes: { body: Record<string, unknown>; key: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/health')) return Response.json({ status: 'ok' });
    if (path.endsWith('/settings')) return readFail ? Response.json({}, { status: 503 }) : Response.json(settings);
    if (path.startsWith('/api/v1/batches?')) return Response.json({ state: 'not_started', items: [], nextCursor: null });
    if (path.endsWith('/commands')) {
      const body = JSON.parse(String(init?.body)); writes.push({ body, key: (init!.headers as Record<string, string>)['Idempotency-Key']! });
      if (fail) return Response.json({}, { status: 503 });
      if (body.operation === 'update_settings') { settings.dailyGoal = body.dailyGoal; settings.version++; }
      return Response.json({ settings });
    }
    return Response.json({}, { status: 404 });
  };
  const port: AuthPort = { onAuthStateChange(listener) { callback = listener; queueMicrotask(() => callback('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; }, signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) };
  const runtime = createAppRuntime(port, transport);
  const view = render(<MemoryRouter initialEntries={[path]}><App runtime={runtime} /></MemoryRouter>);
  return { runtime, writes, settings, fail: (v: boolean) => { fail = v; }, readFail: (v: boolean) => { readFail = v; }, expire: () => act(() => runtime.auth.expire()), reenter: () => act(() => callback('SIGNED_IN', session)), close: async () => { view.unmount(); await runtime.dispose(); } };
}
it('starts only an explicit initial cycle with an unknown date', async () => {
  const h = await mount('/revisoes');
  try {
    await screen.findByRole('button', { name: 'Iniciar ciclo' });
    expect(h.writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Marco do ciclo (opcional)'), { target: { value: 'Marco fictício' } });
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar ciclo' }));
    await screen.findByText('Registro salvo.');
    expect(h.writes[0]!.body).toMatchObject({ operation: 'start_cycle', resetDate: { precision: 'unknown', value: null }, resetMarker: 'Marco fictício' });
  } finally { await h.close(); }
});
it('retains raw goal after expiry and failed reads; selected reapply prepares a separate save', async () => {
  const h = await mount('/configuracoes');
  try {
    fireEvent.change(await screen.findByLabelText('Meta diária'), { target: { value: '8' } });
    h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.settings.version = 3; h.settings.dailyGoal = 6; h.reenter();
    expect(await screen.findByLabelText('Meta diária')).toHaveValue(8);
    fireEvent.click(screen.getByText('Comparar edição')); const dialog = await screen.findByRole('dialog');
    h.readFail(true); fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByRole('alert');
    expect(h.writes).toHaveLength(0); h.readFail(false);
    fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByText('Versões atuais: 3');
    fireEvent.click(within(dialog).getByLabelText('Reaplicar Meta diária')); fireEvent.click(within(dialog).getByText('Reaplicar campos selecionados'));
    expect(h.writes).toHaveLength(0); fireEvent.click(screen.getByText('Salvar intenção preparada')); await screen.findByText('Registro salvo.');
    expect(h.writes[0]!.body).toMatchObject({ dailyGoal: 8, settings: { id, expectedVersion: 3 } });
  } finally { await h.close(); }
});
it('replays the exact uncertain settings intention and never claims a saved backup', async () => {
  const h = await mount('/configuracoes');
  try {
    fireEvent.change(await screen.findByLabelText('Meta diária'), { target: { value: '9' } }); h.fail(true);
    fireEvent.click(screen.getByText('Salvar meta')); await screen.findByText('Repetir intenção original');
    h.fail(false); fireEvent.click(screen.getByText('Repetir intenção original')); await screen.findByText('Registro salvo.');
    expect(h.writes[1]).toEqual(h.writes[0]); expect(screen.getByText(/Nenhum arquivo salvo confirmado nesta sessão/)).toBeInTheDocument();
  } finally { await h.close(); }
});
it('reads a fresh basis before a second distinct goal change in the same session', async () => {
  const h = await mount('/configuracoes');
  try {
    fireEvent.change(await screen.findByLabelText('Meta diária'), { target: { value: '7' } }); fireEvent.click(screen.getByText('Salvar meta')); await screen.findByText('Registro salvo.');
    fireEvent.click(screen.getByText('Editar meta novamente')); await screen.findByText('Salvar meta');
    fireEvent.change(screen.getByLabelText('Meta diária'), { target: { value: '8' } }); fireEvent.click(screen.getByText('Salvar meta')); await screen.findByText('Registro salvo.');
    expect(h.writes).toHaveLength(2); expect(h.writes[1]!.body).toMatchObject({ settings: { id, expectedVersion: 2 }, dailyGoal: 8 }); expect(h.writes[1]!.key).not.toBe(h.writes[0]!.key);
  } finally { await h.close(); }
});

it('exposes exact pending import replay after failure, navigation and same-owner reauthentication', async () => {
  const writes: { body: BodyInit | null | undefined; key: string | null }[] = [];
  let status = 503;
  const h = recoveryHarness('/configuracoes', async (input, init) => {
    const path = String(input);
    if (path.endsWith('/health')) return Response.json({ status: 'ok' });
    if (path.endsWith('/settings')) return Response.json({ id, version: 1, dailyGoal: 5, timezone: 'America/Sao_Paulo' });
    if (path.endsWith('/imports/preview')) return Response.json({ parsed: { blocked: false } });
    if (path.endsWith('/imports/apply')) { writes.push({ body: init?.body, key: new Headers(init?.headers).get('Idempotency-Key') }); return Response.json({ confirmed: status === 200 }, { status }); }
    return Response.json({}, { status: 404 });
  });
  try {
    await screen.findByLabelText('Meta diária');
    fireEvent.change(screen.getByLabelText('Tipo de conferência'), { target: { value: 'unit' } });
    const text = JSON.stringify({ unit: 'complete', data: { runId: '33333333-3333-4333-8333-333333333333' } });
    const file = new File([text], 'synthetic-unit.json', { type: 'application/json' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
    fireEvent.change(screen.getByLabelText('Arquivo privado'), { target: { files: [file] } });
    await screen.findByText('Relatório validado pelo servidor');
    fireEvent.click(screen.getByLabelText('Conferi esta unidade e autorizo sua aplicação privada'));
    fireEvent.click(screen.getByText('Aplicar unidade autorizada'));
    await screen.findByText(/A aplicação não teve confirmação/);
    expect(screen.getByRole('button', { name: 'Repetir mesma unidade retida' })).toBeEnabled();
    expect(screen.getByLabelText('Arquivo privado')).toBeDisabled();
    h.remount(); await screen.findByLabelText('Meta diária');
    expect(screen.getByLabelText('Tipo de conferência')).toHaveValue('csv');
    expect(screen.getByText(/memória desta aba/)).toBeInTheDocument();
    expect(writes).toHaveLength(1);
    status = 401; fireEvent.click(screen.getByText('Repetir mesma unidade retida'));
    await screen.findByRole('heading', { name: 'Entrar' });
    expect(h.runtime.transfers.getSnapshot().pendingImport).not.toBeNull();
    h.reenter(); await screen.findByLabelText('Meta diária');
    expect(writes).toHaveLength(2);
    status = 403; fireEvent.click(screen.getByText('Repetir mesma unidade retida'));
    await screen.findByText(/A aplicação não teve confirmação/);
    expect(screen.queryByText(/Última aplicação confirmada pelo servidor/)).not.toBeInTheDocument();
    expect(h.runtime.transfers.getSnapshot().importStatus).toBe('uncertain');
    status = 200; fireEvent.click(screen.getByText('Repetir mesma unidade retida'));
    await screen.findByText(/Última aplicação confirmada pelo servidor/);
    expect(writes).toHaveLength(4); expect(writes[0]!.key).toBeTruthy();
    expect(writes.slice(1)).toEqual([writes[0], writes[0], writes[0]]);
    expect(h.runtime.transfers.getSnapshot().pendingImport).toBeNull();
    expect(screen.getByLabelText('Tipo de conferência')).toBeEnabled();
    expect(screen.queryByText('Repetir mesma unidade retida')).not.toBeInTheDocument();
    h.remount(); await screen.findByText(/Última aplicação confirmada pelo servidor/);
    expect(writes).toHaveLength(4);
  } finally { await h.close(); }
});

it.each([409, 503])('requires a definitive conflict to prepare a revision after close response %s, failed reread and expiry', async (closeStatus) => {
  const batchId = id; const reviewId = '33333333-3333-4333-8333-333333333333';
  let closed = false; let readFails = false;
  const writes: { body: Record<string, unknown>; key: string | null }[] = [];
  const snapshot = { metrics: { assessment: { numerator: 0, denominator: 30, ratio: 0 } }, eligiblePopulationIds: [], externalResultApplicationIds: [], externalResultEventIds: [] };
  const batch = () => ({ id: batchId, version: closed ? 2 : 1, batchNumber: 1, status: closed ? 'closed' : 'pending', target: 30 });
  const h = recoveryHarness(`/revisoes/${batchId}`, async (input, init) => {
    const path = String(input);
    if (path.endsWith('/health')) return Response.json({ status: 'ok' });
    if (path.startsWith('/api/v1/batches?')) return Response.json({ state: 'started', items: [batch()], nextCursor: null });
    if (path.endsWith(`/batches/${batchId}`)) return readFails ? Response.json({}, { status: 503 }) : Response.json({ batch: batch(), members: [], versions: closed ? [{ id: reviewId, versionNumber: 1, type: 'original' }] : [], preview: snapshot, rectificationPreview: closed ? snapshot : null });
    if (path.endsWith(`/reviews/${reviewId}`)) return Response.json({ version: { id: reviewId, versionNumber: 1, predecessorId: null, type: 'original', narrative: 'Saved by other writer', decisions: ['Current decision'], snapshot, populationIds: [], closedAt: null, createdAt: '2026-11-17T12:00:00Z' }, laterResults: [], externalResults: [] });
    if (path.endsWith('/commands')) {
      const body = JSON.parse(String(init?.body)); writes.push({ body, key: new Headers(init?.headers).get('Idempotency-Key') });
      if (body.operation === 'close_review') { closed = true; return Response.json({ error: {} }, { status: closeStatus }); }
      return Response.json({ saved: true });
    }
    return Response.json({}, { status: 404 });
  });
  try {
    fireEvent.change(await screen.findByRole('textbox', { name: 'Análise' }), { target: { value: 'Retained local analysis' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Próximos passos' }), { target: { value: 'Unselected local decision' } });
    fireEvent.click(screen.getByLabelText('Conferi a população, o balanço e as lacunas'));
    fireEvent.click(screen.getByText('Confirmar fechamento'));
    if (closeStatus === 503) {
      await screen.findByText('Repetir intenção original');
      expect(screen.queryByRole('textbox', { name: 'Motivo' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Repetir intenção original')); await screen.findByText('Repetir intenção original');
      expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
      h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.reenter(); await screen.findByText('Saved by other writer');
    }
    const attemptedWrites = writes.length;
    fireEvent.click(await screen.findByText('Comparar edição'));
    let dialog = await screen.findByRole('dialog');
    readFails = true; fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByRole('alert');
    expect(within(dialog).getByText('Reaplicar campos selecionados')).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Análise' })).toHaveValue('Retained local analysis');
    fireEvent.click(within(dialog).getByText('Fechar e manter edição'));
    expect(writes).toHaveLength(attemptedWrites);
    fireEvent.click(screen.getByText('Comparar edição')); dialog = await screen.findByRole('dialog');
    readFails = false; fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByText('Versões atuais: 2');
    expect(writes).toHaveLength(attemptedWrites); expect(screen.queryByRole('textbox', { name: 'Motivo' })).not.toBeInTheDocument();
    h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.reenter();
    await screen.findByText('Saved by other writer');
    // Reconfirm the unchanged original-close draft so the 503 branch reaches
    // actual revision preflight; its failure must not dispose the old intention.
    if (closeStatus === 503) fireEvent.click(screen.getByLabelText('Conferi a população, o balanço e as lacunas'));
    fireEvent.click(await screen.findByText('Comparar edição')); dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reaplicar campos selecionados')).toBeDisabled();
    fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByText('Versões atuais: 2');
    fireEvent.click(within(dialog).getByLabelText('Reaplicar Análise'));
    fireEvent.click(within(dialog).getByText('Reaplicar campos selecionados'));
    if (closeStatus === 503) {
      await within(dialog).findByRole('alert');
      expect(screen.queryByRole('textbox', { name: 'Motivo' })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Análise' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Análise' })).toHaveValue('Retained local analysis');
      expect(writes).toHaveLength(attemptedWrites); return;
    }
    expect(await screen.findByRole('textbox', { name: 'Motivo' })).toBeEnabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Análise' })).toHaveValue('Retained local analysis');
    expect(screen.getByRole('textbox', { name: 'Próximos passos' })).toHaveValue('Current decision');
    expect(writes).toHaveLength(1);
    const save = screen.getByText('Salvar nova versão privada'); expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Motivo' }), { target: { value: 'Análise complementar' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Relato ou evidência' }), { target: { value: 'Relato explícito do proprietário' } });
    expect(save).toBeDisabled(); fireEvent.click(screen.getByLabelText('Conferi a população, o balanço e as lacunas'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Motivo' }), { target: { value: 'x'.repeat(50_001) } });
    fireEvent.click(save); await screen.findByText('Confira os campos e os limites antes de salvar. Sua edição foi mantida.');
    expect(writes).toHaveLength(1); expect(screen.getByRole('textbox', { name: 'Motivo' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Motivo' }), { target: { value: 'Análise complementar' } });
    expect(writes).toHaveLength(1); fireEvent.click(save); await screen.findByText('Registro salvo.');
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body).toMatchObject({ operation: 'revise_review', batch: { id: batchId, expectedVersion: 2 }, predecessorId: reviewId, narrative: 'Retained local analysis', decisions: ['Current decision'], reason: 'Análise complementar', type: 'revision' });
    expect(writes[1]!.key).not.toBe(writes[0]!.key); expect(writes[1]!.body.evidence).toBeTruthy();
  } finally { await h.close(); }
});

it.each([200, 409])('recovers uncertain close after expiry by exact authorized replay with outcome %s', async (replayStatus) => {
  const h = reviewRecovery(503, replayStatus);
  try {
    await submitClose(); await screen.findByText('Repetir intenção original');
    h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.reenter(); await screen.findByText('Saved version 2');
    expect(screen.queryByText('Repetir intenção original')).not.toBeInTheDocument();
    h.readStatus(403); fireEvent.click(screen.getByText('Comparar edição')); let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByRole('alert');
    expect(screen.queryByText('Repetir intenção original')).not.toBeInTheDocument(); expect(h.writes).toHaveLength(1);
    fireEvent.click(within(dialog).getByText('Fechar e manter edição')); h.readStatus(200);
    dialog = await compareCurrent(3); fireEvent.click(within(dialog).getByText('Fechar e manter edição'));
    h.remount(); await screen.findByText('Saved version 2');
    expect(screen.queryByRole('textbox', { name: 'Motivo' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Repetir intenção original'));
    await waitFor(() => expect(h.writes).toHaveLength(2)); expect(h.writes[1]).toEqual(h.writes[0]);
    if (replayStatus === 200) {
      await screen.findByText('Registro salvo.'); expect(screen.queryByText('Comparar edição')).not.toBeInTheDocument();
      expect(screen.getByText('Preparar nova revisão')).toBeInTheDocument();
    } else {
      dialog = await compareCurrent(3);
      expect(screen.queryByText('Repetir intenção original')).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByLabelText('Reaplicar Análise')); fireEvent.click(within(dialog).getByText('Reaplicar campos selecionados'));
      expect(screen.getByRole('textbox', { name: 'Motivo' })).toBeEnabled(); expect(h.writes).toHaveLength(2);
      fireEvent.change(screen.getByRole('textbox', { name: 'Motivo' }), { target: { value: 'Complementar análise' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'Relato ou evidência' }), { target: { value: 'Relato explícito' } });
      fireEvent.click(screen.getByLabelText('Conferi a população, o balanço e as lacunas')); fireEvent.click(screen.getByText('Salvar nova versão privada'));
      await screen.findByText('Registro salvo.'); expect(h.writes).toHaveLength(3);
      expect(h.writes[2]!.body).toMatchObject({ operation: 'revise_review', batch: { id, expectedVersion: 3 }, predecessorId: h.latestId, narrative: 'Retained local analysis' });
      expect(h.writes[2]!.key).not.toBe(h.writes[0]!.key);
    }
  } finally { await h.close(); }
});

it('keeps denied goal drafts recoverable through denied reread and explicit restored-access reapply', async () => {
  let denied = false; let version = 1; const writes: { body: Record<string, unknown>; key: string | null }[] = [];
  const h = recoveryHarness('/configuracoes', async (input, init) => {
    const path = String(input);
    if (path.endsWith('/health')) return Response.json({ status: 'ok' });
    if (path.endsWith('/settings')) return denied ? Response.json({}, { status: 403 }) : Response.json({ id, version, dailyGoal: 5, timezone: 'America/Sao_Paulo' });
    if (path.endsWith('/commands')) { writes.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('Idempotency-Key') }); return Response.json({}, { status: denied ? 403 : 200 }); }
    return Response.json({}, { status: 404 });
  });
  try {
    fireEvent.change(await screen.findByLabelText('Meta diária'), { target: { value: '8' } }); denied = true;
    fireEvent.click(screen.getByText('Salvar meta')); await screen.findByText('Acesso não autorizado.');
    expect(screen.getByLabelText('Meta diária')).toHaveValue(8); expect(screen.getByLabelText('Meta diária')).toBeDisabled();
    fireEvent.click(screen.getByText('Comparar edição')); let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByRole('alert');
    expect(within(dialog).getByText('Reaplicar campos selecionados')).toBeDisabled(); expect(screen.queryByText('Repetir intenção original')).not.toBeInTheDocument(); expect(writes).toHaveLength(1);
    fireEvent.click(within(dialog).getByText('Fechar e manter edição')); denied = false; version = 2;
    dialog = await compareCurrent(2); fireEvent.click(within(dialog).getByLabelText('Reaplicar Meta diária')); fireEvent.click(within(dialog).getByText('Reaplicar campos selecionados'));
    expect(writes).toHaveLength(1); fireEvent.click(screen.getByText('Salvar intenção preparada')); await screen.findByText('Registro salvo.');
    expect(writes).toHaveLength(2); expect(writes[1]!.body).toMatchObject({ dailyGoal: 8, settings: { id, expectedVersion: 2 } }); expect(writes[1]!.key).not.toBe(writes[0]!.key);
  } finally { await h.close(); }
});

it('shows actual draft snapshot, population and gaps independently of stale preview and historical selection', async () => {
  const h = reviewRecovery(409);
  try {
    await submitClose(); const dialog = await compareCurrent(3);
    fireEvent.click(within(dialog).getByLabelText('Reaplicar Análise')); fireEvent.click(within(dialog).getByText('Reaplicar campos selecionados'));
    let basis = screen.getByRole('region', { name: 'Base para confirmar este rascunho' });
    expect(basis).toHaveTextContent('3 / 30'); expect(basis).toHaveTextContent('30 elegíveis de 30'); expect(basis).toHaveTextContent('Cargo ausente: 1');
    expect(within(basis).getAllByRole('link')).toHaveLength(30); expect(basis).toHaveTextContent(h.populationIds[0]!);
    expect(screen.getByRole('region', { name: 'Balanço da versão' })).toHaveTextContent('0 / 30'); expect(h.writes).toHaveLength(1);
    fireEvent.click(screen.getByText('Atualizar leitura do lote')); await screen.findByText('Saved version 2');
    fireEvent.change(screen.getByLabelText('Versão selecionada'), { target: { value: h.originalId } }); await screen.findByText('Saved version 1');
    basis = screen.getByRole('region', { name: 'Base para confirmar este rascunho' });
    expect(screen.getByRole('region', { name: 'Balanço da versão' })).toHaveTextContent('1 / 30'); expect(basis).toHaveTextContent('3 / 30');
    expect(screen.getByRole('textbox', { name: 'Análise' })).toHaveValue('Retained local analysis');
    fireEvent.change(screen.getByRole('textbox', { name: 'Motivo' }), { target: { value: 'Complementar' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Relato ou evidência' }), { target: { value: 'Relato explícito' } });
    fireEvent.click(screen.getByLabelText('Conferi a população, o balanço e as lacunas'));
    fireEvent.change(screen.getByLabelText('Tipo da nova versão'), { target: { value: 'rectification' } });
    expect(basis).toHaveTextContent('4 / 30'); expect(screen.getByText('Salvar nova versão privada')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Tipo da nova versão'), { target: { value: 'revision' } }); expect(basis).toHaveTextContent('3 / 30');
    fireEvent.click(screen.getByLabelText('Conferi a população, o balanço e as lacunas')); fireEvent.click(screen.getByText('Salvar nova versão privada')); await screen.findByText('Registro salvo.');
    expect(h.writes).toHaveLength(2); expect(h.writes[1]!.body).toMatchObject({ operation: 'revise_review', predecessorId: h.latestId, batch: { id, expectedVersion: 3 } });
    expect(JSON.stringify({ original: h.original, latest: h.latest })).toBe(h.frozen); expect(screen.getByRole('region', { name: 'Balanço da versão' })).toHaveTextContent('1 / 30');
  } finally { await h.close(); }
});

it('recovers a directly denied review through authorized comparison and a separate save', async () => {
  const h = reviewRecovery(403);
  try {
    await submitClose(); await screen.findByText('Acesso não autorizado.');
    expect(screen.getByRole('textbox', { name: 'Análise' })).toBeDisabled();
    expect(screen.queryByText('Repetir intenção original')).not.toBeInTheDocument();
    h.readStatus(403); fireEvent.click(screen.getByText('Comparar edição')); let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Reler versão atual')); await within(dialog).findByRole('alert');
    expect(within(dialog).getByText('Reaplicar campos selecionados')).toBeDisabled(); expect(h.writes).toHaveLength(1);
    fireEvent.click(within(dialog).getByText('Fechar e manter edição')); h.readStatus(200); dialog = await compareCurrent(1);
    fireEvent.click(within(dialog).getByLabelText('Reaplicar Análise')); fireEvent.click(within(dialog).getByText('Reaplicar campos selecionados'));
    expect(h.writes).toHaveLength(1); expect(screen.getByText('Salvar intenção preparada')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Conferi a população, o balanço e as lacunas')); fireEvent.click(screen.getByText('Salvar intenção preparada')); await screen.findByText('Registro salvo.');
    expect(h.writes).toHaveLength(2); expect(h.writes[1]!.body).toMatchObject({ operation: 'close_review', narrative: 'Retained local analysis' });
  } finally { await h.close(); }
});
