// @vitest-environment jsdom
import '../../src/app/validation';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@supabase/supabase-js';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { createAppRuntime } from '../../src/app/runtime';
import type { AuthPort } from '../../src/lib/auth';
import { MAX_CSV_UPLOAD_BYTES, type CsvPreview } from '../../shared/csv-upload';

afterEach(cleanup);

const preview: CsvPreview = {
  writes: false, blocked: false, confirmation: '2'.repeat(64),
  totals: { rows: 3, eligible: 1, unchanged: 1, review: 1 }, issues: [],
  rows: [
    { number: 2, legacyId: 'V901', company: 'Empresa Exemplo', title: 'Dados', submittedDate: { precision: 'unknown', value: null }, submissionStatus: 'confirmado', cycleOrder: 7, missing: ['data_envio'], issues: [], status: 'eligible' },
    { number: 3, legacyId: 'V902', company: '', title: 'Pesquisa', submittedDate: { precision: 'unknown', value: null }, submissionStatus: 'nao_enviado', cycleOrder: null, missing: ['empresa'], issues: [], status: 'unchanged' },
    { number: 4, legacyId: 'V903', company: 'Outra Empresa', title: 'Análise', submittedDate: { precision: 'unknown', value: null }, submissionStatus: 'nao_confirmado', cycleOrder: null, missing: [], issues: ['source_changed'], status: 'conflict' },
  ],
};

function mount() {
  const session = { access_token: 'synthetic', user: { id: '11111111-1111-4111-8111-111111111111' } } as Session;
  const port: AuthPort = {
    onAuthStateChange(callback) { queueMicrotask(() => callback('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; },
    signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }),
    resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }),
  };
  const calls: { path: string; body: string; key: string | null; init?: RequestInit }[] = [];
  let status: number | 'network' = 200;
  const runtime = createAppRuntime(port, async (url, init) => {
    const path = String(url);
    if (path.endsWith('/health')) return Response.json({ status: 'ok' });
    if (path.includes('/applications?')) return Response.json({ items: [], total: 0, nextCursor: null });
    calls.push({ path, body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key'), init });
    if (path.endsWith('/preview')) return Response.json(preview);
    if (status === 'network') throw new Error('Interrupted response');
    if (status !== 200) return Response.json({}, { status });
    return Response.json({ runId: '22222222-2222-4222-8222-222222222222', imported: 1, unchanged: 1, review: 1 });
  });
  const view = render(<MemoryRouter initialEntries={['/vagas']}><App runtime={runtime} /></MemoryRouter>);
  return { user: userEvent.setup(), calls, setStatus: (value: typeof status) => { status = value; }, close: async () => { view.unmount(); await runtime.dispose(); } };
}

const testFile = () => new File(['fictício\r\n'], 'fixture.csv', { type: 'text/csv' });

it('opens from Vagas, requires explicit confirmation, and replays the same private request after a lost response', async () => {
  const h = mount();
  try {
    await h.user.click(await screen.findByRole('link', { name: 'Importar CSV' }));
    expect(screen.getByRole('link', { name: 'Vagas' })).toHaveAttribute('aria-current', 'page');
    const file = screen.getByLabelText('Arquivo CSV');
    await h.user.upload(file, testFile());
    await h.user.click(screen.getByRole('button', { name: 'Conferir arquivo' }));
    await screen.findByText('Empresa Exemplo');
    expect(screen.getByText('A fonte mudou desde a importação anterior.')).toBeInTheDocument();
    expect(screen.getAllByText('Não informada').length).toBeGreaterThan(0);
    const confirm = screen.getByRole('button', { name: 'Importar 1 linha' });
    expect(confirm).toBeDisabled();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(JSON.parse(h.calls[0]!.body)).toMatchObject({ fileName: 'fixture.csv', format: 'csv_upload', bytesBase64: 'ZmljdMOtY2lvDQo=' });

    h.setStatus('network');
    await h.user.click(screen.getByRole('checkbox', { name: /conferi a prévia/i }));
    await h.user.click(confirm);
    await screen.findByText(/resultado ainda não confirmado/i);
    await h.user.click(screen.getByRole('link', { name: 'Voltar para Vagas' }));
    await h.user.click(await screen.findByRole('link', { name: 'Importar CSV' }));
    h.setStatus(200);
    await h.user.click(await screen.findByRole('button', { name: 'Repetir confirmação' }));
    await screen.findByRole('heading', { name: 'Importação concluída' });
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1]?.body).toBe(h.calls[2]?.body);
    expect(h.calls[1]?.key).toBeTruthy();
    expect(h.calls[1]?.key).toBe(h.calls[2]?.key);
    expect(screen.getByText('Importadas')).toBeInTheDocument();
  } finally { await h.close(); }
});

it('rejects oversize locally and requires a new preview after a stale confirmation', async () => {
  const h = mount();
  try {
    await h.user.click(await screen.findByRole('link', { name: 'Importar CSV' }));
    const input = screen.getByLabelText('Arquivo CSV');
    await h.user.upload(input, new File([new Uint8Array(MAX_CSV_UPLOAD_BYTES + 1)], 'grande.csv', { type: 'text/csv' }));
    await h.user.click(screen.getByRole('button', { name: 'Conferir arquivo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 MiB');
    expect(h.calls).toHaveLength(0);
    await h.user.upload(input, testFile());
    await h.user.click(screen.getByRole('button', { name: 'Conferir arquivo' }));
    const approval = await screen.findByRole('checkbox', { name: /conferi a prévia/i });
    h.setStatus(409);
    await h.user.click(approval);
    await h.user.click(screen.getByRole('button', { name: 'Importar 1 linha' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/gere uma nova prévia/i));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Repetir confirmação' })).toBeNull();
  } finally { await h.close(); }
});
