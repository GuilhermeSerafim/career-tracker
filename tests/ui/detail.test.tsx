// @vitest-environment jsdom
import '../../src/app/validation';
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { App } from '../../src/app/App';
import { createAppRuntime } from '../../src/app/runtime';
import type { AuthPort } from '../../src/lib/auth';
import type { Command } from '../../shared/commands';
import type { DetailTask } from '../../src/features/applications/application-data';
import { contactAtByteBoundary } from '../helpers/command-budget';
import { commandSchema } from '../../shared/commands';
import { canonicalRequestHash } from '../../server/mutation';

afterEach(cleanup);
const id = '22222222-2222-4222-8222-222222222222';
const contactId = '44444444-4444-4444-8444-444444444444';
const eventId = '55555555-5555-4555-8555-555555555555';
const unknown = { precision: 'unknown' as const, value: null };
async function mount(options: { edit?: boolean; canonical?: string } = {}) {
  let listener!: (event: AuthChangeEvent, session: Session | null) => void;
  const session = { access_token: 'synthetic', user: { id: '11111111-1111-4111-8111-111111111111' } } as Session;
  const contact = { id: contactId, version: 1, name: null as string | null, notes: 'Anotação original', links: [] };
  const application = { id, version: 1, displayId: 'N000001', submissionStatus: 'nao_confirmado', submittedDate: unknown, stage: 'avaliacao', countingEligible: true, canonicalApplicationId: null as string | null, archivedAt: null, cycleRelation: 'before_reset', cycleOrder: null, stack: [], discoveryChannel: null, submissionPlatform: null, resumeIds: [], track: null, applicationInstance: 'initial', notes: null, eventIds: [eventId], historyApplicationIds: [id], opportunity: { id: '33333333-3333-4333-8333-333333333333', version: 1, company: 'Empresa fictícia', title: 'Engenharia', stack: [] } };
  const detail = { application, links: [{ originalUrl: 'https://example.test/private?token=fictional', kind: 'original', isLocal: false, isPrivate: true }], resumeRefs: [], affectedBatches: [], contacts: [contact], tasks: [] as DetailTask[], evidence: [{ id: '66666666-6666-4666-8666-666666666666', kind: 'relato_usuario', originalText: '<img src=x onerror=alert(1)>', source: 'Relato fictício', occurredDate: null, privateRef: null, localRef: 'C:/fictional/evidence.txt' }], events: [{ id: eventId, version: 1, applicationId: id, kind: 'avaliacao', state: 'concluido', occurredDate: { precision: 'month', value: '2026-10', certainty: 'approximate' }, resultText: 'Avaliação reaproveitada', scoreValue: 79, scoreUnit: '%', sourceText: 'Resultado informado', recordedAt: '2026-11-16T12:00:00Z', evidenceId: '66666666-6666-4666-8666-666666666666', supersedesEventId: null, superseded: false }] };
  let failure = 0; let failRead = false;
  const writes: { body: Command; raw: string; key: string }[] = [];
  const runtime = createAppRuntime({ onAuthStateChange: (fn) => { listener = fn; queueMicrotask(() => fn('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; }, signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) } as AuthPort, async (path, init) => {
    if (String(path).endsWith('/health')) return Response.json({ status: 'ok' });
    if (String(path).startsWith('/api/v1/contacts?')) return Response.json({ items: [contact], total: 1, nextCursor: null });
    if (String(path).endsWith('/commands')) {
      const body = JSON.parse(String(init!.body)) as Command; writes.push({ body, raw: String(init!.body), key: (init!.headers as Record<string, string>)['Idempotency-Key']! });
      if (failure) return Response.json({ error: { code: failure === 409 ? 'CONFLICT' : 'INVALID_INPUT' } }, { status: failure });
      return Response.json({ event: null, task: null, contact, parents: { application: null, contact: null }, existing: false });
    }
    if (failRead) return Response.json({ error: {} }, { status: 503 });
    if (String(path).includes('/contacts/')) return Response.json(contact);
    return Response.json(detail);
  });
  application.canonicalApplicationId = options.canonical ?? null;
  const view = render(<MemoryRouter initialEntries={[`/vagas/${id}${options.edit ? '/editar' : ''}`]}><App runtime={runtime} /></MemoryRouter>);
  return { runtime, detail, contact, writes, reject: (status: number) => { failure = status; }, failRead: (value: boolean) => { failRead = value; }, expire: () => act(() => runtime.auth.expire()), reenter: () => act(() => listener('SIGNED_IN', session)), close: async () => { view.unmount(); await runtime.dispose(); } };
}

it('reads occurrence precision, evidence and reported scores without inventing a submission or approval', async () => {
  const h = await mount();
  try {
    const history = await screen.findByRole('region', { name: 'Histórico do processo' });
    expect(history).toHaveTextContent('outubro de 2026 (aproximado)'); expect(history).toHaveTextContent('Registrado em');
    expect(history).toHaveTextContent('Precisão: mês'); expect(history).toHaveTextContent('Certeza: aproximada');
    expect(history).toHaveTextContent('79 %'); expect(history).toHaveTextContent('Resultado informado');
    expect(history).toHaveTextContent('<img src=x onerror=alert(1)>'); expect(history.querySelector('img')).toBeNull();
    expect(screen.getByRole('region', { name: 'Envio e etapa' })).toHaveTextContent('Envio desconhecido');
    expect(screen.getByRole('region', { name: 'Envio e etapa' })).toHaveTextContent('Avaliação');
    expect(screen.getByText(/Resultado de processo anterior/)).toBeVisible(); expect(h.writes).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Editar registro' })).toHaveAttribute('href', `/vagas/${id}/editar`);
  } finally { await h.close(); }
});

it('rejects the proven contact envelope overflow before freezing raw input, then saves a shorter correction separately', async () => {
  const oversized = contactAtByteBoundary();
  expect(commandSchema.safeParse(oversized).success).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBe(262_134);
  expect(() => canonicalRequestHash({ command: oversized, idempotencyKey: contactId })).toThrow(expect.objectContaining({ status: 413 }));
  const h = await mount();
  try {
    const form = await screen.findByRole('region', { name: 'Criar contato opcional' });
    fireEvent.change(within(form).getByLabelText('Notas do contato'), { target: { value: oversized.data.notes } });
    fireEvent.change(within(form).getByLabelText('Novos links do contato'), { target: { value: oversized.data.links.map((link) => link.originalUrl).join('\n') } });
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar contato' }));
    expect(h.writes).toHaveLength(0);
    expect(within(form).getByLabelText('Notas do contato')).toHaveValue(oversized.data.notes);
    expect(within(form).getByLabelText('Notas do contato')).toBeEnabled();
    expect(within(form).queryByRole('button', { name: 'Repetir intenção original' })).toBeNull();
    fireEvent.change(within(form).getByLabelText('Notas do contato'), { target: { value: 'Notas fictícias encurtadas.' } });
    expect(h.writes).toHaveLength(0);
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar contato' })); await within(form).findByText('Registro salvo.');
    expect(h.writes).toHaveLength(1); expect(h.writes[0]!.body).toMatchObject({ operation: 'save_contact', data: { notes: 'Notas fictícias encurtadas.' } });
    expect(() => canonicalRequestHash({ command: h.writes[0]!.body, idempotencyKey: h.writes[0]!.key })).not.toThrow();
  } finally { await h.close(); }
});

it.each([503, 413])('keeps received HTTP %s contact failure frozen for exact replay rather than editable revision', async (status) => {
  const h = await mount();
  try {
    const form = await screen.findByRole('region', { name: 'Criar contato opcional' });
    fireEvent.change(within(form).getByLabelText('Notas do contato'), { target: { value: 'Intenção com resposta incerta.' } });
    h.reject(status); fireEvent.click(within(form).getByRole('button', { name: 'Salvar contato' }));
    await within(form).findByRole('button', { name: 'Repetir intenção original' });
    expect(within(form).getByLabelText('Notas do contato')).toBeDisabled();
    expect(within(form).queryByRole('button', { name: 'Revisar registro recusado' })).toBeNull();
    h.reject(0); fireEvent.click(within(form).getByRole('button', { name: 'Repetir intenção original' })); await within(form).findByText('Registro salvo.');
    expect(h.writes).toHaveLength(2); expect(h.writes[1]).toEqual(h.writes[0]);
  } finally { await h.close(); }
});

it('preserves raw event/date input through timeline refresh and same-owner login then replays uncertainty exactly', async () => {
  const h = await mount();
  try {
    const form = await screen.findByRole('region', { name: 'Registrar atividade' });
    fireEvent.change(within(form).getByLabelText('Resultado ou relato'), { target: { value: 'Minha intenção pendente' } });
    fireEvent.change(within(form).getByLabelText('Precisão'), { target: { value: 'day' } });
    fireEvent.change(within(form).getByLabelText('Certeza'), { target: { value: 'approximate' } });
    fireEvent.change(within(form).getByLabelText('Dia, mês e ano'), { target: { value: '2026-11-' } });
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar histórico' }));
    expect(within(form).getByLabelText('Resultado ou relato')).toHaveValue('Minha intenção pendente');
    h.expire(); await screen.findByRole('heading', { name: 'Entrar' }); h.reenter();
    const retained = await screen.findByRole('region', { name: 'Registrar atividade' });
    expect(within(retained).getByLabelText('Dia, mês e ano')).toHaveValue('2026-11-');
    expect(within(retained).getByRole('button', { name: 'Salvar atividade' })).toBeDisabled();
    fireEvent.change(within(retained).getByLabelText('Dia, mês e ano'), { target: { value: '2026-11-10' } });
    h.reject(503); fireEvent.click(within(retained).getByRole('button', { name: 'Salvar atividade' }));
    fireEvent.click(await within(retained).findByRole('button', { name: 'Repetir intenção original' }));
    expect(h.writes).toHaveLength(2); expect(h.writes[1]!.raw).toBe(h.writes[0]!.raw); expect(h.writes[1]!.key).toBe(h.writes[0]!.key);
    expect(within(retained).queryByText('Revisar registro recusado')).toBeNull();
  } finally { await h.close(); }
});

it('reapplies only selected contact fields using the authorized current version and a new intention', async () => {
  const h = await mount();
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Editar contato sem nome' }));
    const form = screen.getByRole('region', { name: 'Editar contato' });
    fireEvent.change(within(form).getByLabelText('Nome do contato'), { target: { value: 'Nome informado' } });
    fireEvent.change(within(form).getByLabelText('Notas do contato'), { target: { value: 'Não selecionada' } });
    h.contact.version = 4; h.contact.notes = 'Alteração da outra aba'; h.reject(409);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar histórico' }));
    await screen.findByText('Alteração da outra aba', { selector: '.detail-contact p' });
    expect(within(form).getByLabelText('Notas do contato')).toHaveValue('Não selecionada');
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar contato' }));
    const dialog = await screen.findByRole('dialog', { name: 'Conflito de edição' });
    expect(h.writes[0]!.body).toMatchObject({ operation: 'save_contact', target: { id: contactId, expectedVersion: 1 }, data: { name: 'Nome informado', notes: 'Não selecionada' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reler versão atual' }));
    await within(dialog).findByText('Alteração da outra aba'); expect(h.writes).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Reaplicar Nome do contato' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reaplicar campos selecionados' }));
    expect(h.writes).toHaveLength(1); h.reject(0);
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar intenção preparada' }));
    await within(form).findByText('Registro salvo.');
    expect(h.writes[1]!.body).toMatchObject({ operation: 'save_contact', target: { id: contactId, expectedVersion: 4 }, data: { name: 'Nome informado', notes: 'Alteração da outra aba' } });
    expect(h.writes[1]!.key).not.toBe(h.writes[0]!.key);
  } finally { await h.close(); }
});

it('recovers definitive rejection through an authorized revision while preserving the refused input', async () => {
  const h = await mount();
  try {
    const form = await screen.findByRole('region', { name: 'Registrar atividade' });
    fireEvent.change(within(form).getByLabelText('Nota informada'), { target: { value: '79' } });
    fireEvent.change(within(form).getByLabelText('Resultado ou relato'), { target: { value: 'Meu relato' } });
    h.reject(400); fireEvent.click(within(form).getByRole('button', { name: 'Salvar atividade' }));
    h.failRead(true); fireEvent.click(await within(form).findByRole('button', { name: 'Revisar registro recusado' }));
    await within(form).findByText(/Não foi possível reler/); expect(within(form).getByLabelText('Resultado ou relato')).toHaveValue('Meu relato');
    h.failRead(false); fireEvent.click(within(form).getByRole('button', { name: 'Revisar registro recusado' }));
    await within(form).findByRole('button', { name: 'Preparar intenção corrigida' });
    fireEvent.change(within(form).getByLabelText('Unidade da nota'), { target: { value: '%' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Preparar intenção corrigida' }));
    const dialog = await screen.findByRole('dialog');
    for (const name of ['Nota informada', 'Unidade da nota', 'Resultado ou relato']) fireEvent.click(within(dialog).getByRole('checkbox', { name: `Reaplicar ${name}` }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reaplicar campos selecionados' })); expect(h.writes).toHaveLength(1);
    h.reject(0); fireEvent.click(within(form).getByRole('button', { name: 'Salvar intenção preparada' }));
    await within(form).findByText('Registro salvo.'); expect(h.writes[1]!.body).toMatchObject({ operation: 'record_event', data: { resultText: 'Meu relato', scoreValue: 79, scoreUnit: '%' } });
    expect(h.writes[1]!.key).not.toBe(h.writes[0]!.key);
  } finally { await h.close(); }
});

it('sends both parent versions for a linked task and rereads them before selected reapplication', async () => {
  const h = await mount();
  try {
    const form = await screen.findByRole('region', { name: 'Criar próxima ação' });
    fireEvent.change(within(form).getByLabelText('Próxima ação'), { target: { value: 'Retomar conversa fictícia' } });
    fireEvent.change(within(form).getByLabelText('Contato opcional'), { target: { value: contactId } });
    h.reject(409); fireEvent.click(within(form).getByRole('button', { name: 'Salvar próxima ação' }));
    const dialog = await screen.findByRole('dialog');
    expect(h.writes[0]!.body).toMatchObject({ operation: 'save_task', parents: { application: { id, expectedVersion: 1 }, contact: { id: contactId, expectedVersion: 1 } } });
    h.detail.application.version = 6; h.contact.version = 3;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reler versão atual' }));
    await within(dialog).findByText('Versões atuais: 6, 3');
    for (const label of ['Próxima ação', 'Contato opcional']) fireEvent.click(within(dialog).getByRole('checkbox', { name: `Reaplicar ${label}` }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reaplicar campos selecionados' })); h.reject(0);
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar intenção preparada' })); await within(form).findByText('Registro salvo.');
    expect(h.writes[1]!.body).toMatchObject({ operation: 'save_task', parents: { application: { id, expectedVersion: 6 }, contact: { id: contactId, expectedVersion: 3 } }, data: { title: 'Retomar conversa fictícia', dueDate: unknown } });
    expect(h.writes[1]!.key).not.toBe(h.writes[0]!.key);
  } finally { await h.close(); }
});

it('retains the original interpretation and requires reason and evidence for its explicit correction', async () => {
  const h = await mount();
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Corrigir interpretação deste evento' }));
    const form = screen.getByRole('region', { name: 'Corrigir interpretação' });
    fireEvent.change(within(form).getByLabelText('Situação da atividade'), { target: { value: 'convidado' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar correção' }));
    expect(h.writes).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText('Motivo da correção'), { target: { value: 'Era convite, não conclusão.' } });
    fireEvent.change(within(form).getByLabelText('Evidência da atividade'), { target: { value: 'Reli o convite fictício.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar correção' })); await within(form).findByText('Registro salvo.');
    expect(h.writes[0]!.body).toMatchObject({ operation: 'correct_event', eventId, application: { id, expectedVersion: 1 }, replacement: { state: 'convidado', scoreValue: 79, scoreUnit: '%' }, reason: 'Era convite, não conclusão.', evidence: { originalText: 'Reli o convite fictício.' } });
    expect(screen.getByRole('region', { name: 'Histórico do processo' })).toHaveTextContent('Avaliação reaproveitada');
  } finally { await h.close(); }
});

it('uses the newer linked contact version after saved-detail refresh even when the catalog cache is older', async () => {
  const h = await mount();
  try {
    await screen.findByRole('region', { name: 'Contatos opcionais' });
    h.detail.application.version = 8;
    h.detail.contacts = [{ ...h.contact, version: 4 }];
    h.detail.tasks.push({ id: eventId, version: 1, applicationId: id, contactId, title: 'Conferir resultado', status: 'pending', dueDate: unknown, completedDate: unknown });
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar histórico' }));
    fireEvent.click(await screen.findByText('Concluir ação', { selector: 'summary' }));
    const form = screen.getByRole('region', { name: 'Concluir: Conferir resultado' });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirmar conclusão' }));
    await within(form).findByText('Registro salvo.');
    expect(h.writes[0]!.body).toMatchObject({ operation: 'complete_task', task: { id: eventId, expectedVersion: 1 }, parents: { application: { id, expectedVersion: 8 }, contact: { id: contactId, expectedVersion: 4 } } });
  } finally { await h.close(); }
});

it('keeps merged alias history readable and requires deliberate canonical navigation for application writes', async () => {
  const h = await mount();
  try {
    await screen.findByRole('region', { name: 'Histórico do processo' });
    h.detail.application.canonicalApplicationId = contactId;
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar histórico' }));
    expect(await screen.findByRole('link', { name: 'Abrir registro canônico para acompanhar ou corrigir' })).toHaveAttribute('href', `/vagas/${contactId}`);
    expect(screen.queryByRole('link', { name: 'Editar registro' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Registrar atividade' })).toBeNull(); expect(screen.queryByRole('region', { name: 'Criar próxima ação' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Histórico do processo' })).toHaveTextContent('Avaliação reaproveitada'); expect(h.writes).toHaveLength(0);
  } finally { await h.close(); }
});

it('explains direct alias edit links and offers the canonical editor instead of an unwritable form', async () => {
  const h = await mount({ edit: true, canonical: contactId });
  try {
    expect(await screen.findByRole('link', { name: 'Abrir edição do registro canônico' })).toHaveAttribute('href', `/vagas/${contactId}/editar`);
    expect(screen.queryByRole('button', { name: 'Salvar alterações' })).toBeNull(); expect(h.writes).toHaveLength(0);
  } finally { await h.close(); }
});

it('keeps a pending activity visible after an alias conflict and a separate timeline refresh without transplanting it', async () => {
  const h = await mount();
  try {
    const form = await screen.findByRole('region', { name: 'Registrar atividade' });
    fireEvent.change(within(form).getByLabelText('Resultado ou relato'), { target: { value: 'Atividade anterior à união' } });
    h.detail.application.version = 2; h.detail.application.canonicalApplicationId = contactId; h.reject(409);
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar atividade' }));
    const dialog = await screen.findByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Reler versão atual' }));
    expect(await within(dialog).findByRole('link', { name: 'Abrir registro canônico' })).toHaveAttribute('href', `/vagas/${contactId}`);
    expect(within(dialog).getByRole('button', { name: 'Reaplicar campos selecionados' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar e manter edição' }));
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar histórico' })); await screen.findByRole('link', { name: 'Abrir registro canônico para acompanhar ou corrigir' });
    expect(within(screen.getByRole('region', { name: 'Registrar atividade' })).getByLabelText('Resultado ou relato')).toHaveValue('Atividade anterior à união');
    expect(within(screen.getByRole('region', { name: 'Registrar atividade' })).getByLabelText('Resultado ou relato')).toBeDisabled();
    expect(h.writes).toHaveLength(1); expect(h.writes[0]!.body).toMatchObject({ operation: 'record_event', application: { id, expectedVersion: 1 }, data: { resultText: 'Atividade anterior à união' } });
  } finally { await h.close(); }
});

it('keeps exact uncertain replay available when a separate read discovers the application became an alias', async () => {
  const h = await mount();
  try {
    const form = await screen.findByRole('region', { name: 'Registrar atividade' });
    fireEvent.change(within(form).getByLabelText('Resultado ou relato'), { target: { value: 'Resultado sem confirmação da gravação' } });
    h.reject(503); fireEvent.click(within(form).getByRole('button', { name: 'Salvar atividade' }));
    await within(form).findByRole('button', { name: 'Repetir intenção original' });
    h.detail.application.version = 2; h.detail.application.canonicalApplicationId = contactId;
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar histórico' })); await screen.findByRole('link', { name: 'Abrir registro canônico para acompanhar ou corrigir' });
    h.reject(0); fireEvent.click(within(form).getByRole('button', { name: 'Repetir intenção original' }));
    await within(form).findByText('Registro salvo.'); expect(h.writes).toHaveLength(2); expect(h.writes[1]).toEqual(h.writes[0]);
  } finally { await h.close(); }
});
