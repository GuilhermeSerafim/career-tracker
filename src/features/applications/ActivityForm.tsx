import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import type { AppRuntime } from '../../app/runtime';
import { ApiError, createSaveIntent } from '../../lib/api';
import type { CurrentVersion } from '../../lib/api';
import { commandSchema } from '../../../shared/commands';
import type { Command } from '../../../shared/commands';
import type { DateValue, EventKind, EventState } from '../../../shared/model';
import { DateField } from '../../components/DateField';
import type { DateEditorState } from '../../components/DateField';
import { ConflictDialog } from '../../components/ConflictDialog';
import { eventKinds, eventStates, evidence, nullable, readDetail, unknownDate } from './application-data';
import type { Detail, DetailContact, DetailEvent, DetailTask } from './application-data';

type Mode = 'event' | 'correction' | 'task' | 'complete' | 'contact';
interface Input { kind: EventKind; state: EventState; date: DateValue; dateEditor?: DateEditorState; result: string; score: string; unit: string; source: string; proof: string; reason: string; title: string; contactId: string; name: string; notes: string; links: string }
interface Context { detail: Detail; contact?: DetailContact; task?: DetailTask; event?: DetailEvent }
interface Result { contact: DetailContact | null }
const labels: Partial<Record<keyof Input, string>> = { kind: 'Tipo de atividade', state: 'Situação da atividade', date: 'Data do acontecimento', result: 'Resultado ou relato', score: 'Nota informada', unit: 'Unidade da nota', source: 'Origem do resultado', proof: 'Evidência da atividade', reason: 'Motivo da correção', title: 'Próxima ação', contactId: 'Contato opcional', name: 'Nome do contato', notes: 'Notas do contato', links: 'Novos links do contato' };
const fieldsFor = (mode: Mode): (keyof Input)[] => mode === 'contact' ? ['name', 'notes', 'links'] : mode === 'task' ? ['title', 'date', 'contactId'] : mode === 'complete' ? ['date'] : ['kind', 'state', 'date', 'result', 'score', 'unit', 'source', 'proof', ...(mode === 'correction' ? ['reason' as const] : [])];
function inputFrom(mode: Mode, context: Context): Input {
  const e = mode === 'correction' ? context.event : undefined;
  return { kind: e?.kind ?? 'nota', state: e?.state ?? 'informado', date: e?.occurredDate ?? (mode === 'complete' ? context.task?.completedDate : mode === 'task' ? context.task?.dueDate : undefined) ?? unknownDate, result: e?.resultText ?? '', score: e?.scoreValue == null ? '' : String(e.scoreValue), unit: e?.scoreUnit ?? '', source: e?.sourceText ?? '', proof: '', reason: '', title: context.task?.title ?? '', contactId: context.task?.contactId ?? '', name: context.contact?.name ?? '', notes: context.contact?.notes ?? '', links: '' };
}
const comparable = (mode: Mode, input: Input) => Object.fromEntries(fieldsFor(mode).map((key) => [labels[key]!, typeof input[key] === 'object' ? JSON.stringify(input[key]) : String(input[key] ?? '')])) as CurrentVersion['fields'];
const ref = (row: { id: string; version: number }) => ({ id: row.id, expectedVersion: row.version });
function command(mode: Mode, input: Input, context: Context): Command {
  if (mode !== 'contact' && context.detail.application.canonicalApplicationId) throw new ApiError(409);
  const application = ref(context.detail.application);
  if (mode === 'contact') return commandSchema.parse({ operation: 'save_contact', target: context.contact ? ref(context.contact) : { clientId: crypto.randomUUID() }, data: { name: nullable(input.name), notes: nullable(input.notes), links: input.links.split('\n').map((s) => s.trim()).filter(Boolean).map((originalUrl) => ({ originalUrl, comparisonUrl: null, kind: 'contato', isLocal: false, isPrivate: true })) } });
  if (mode === 'task' || mode === 'complete') {
    const contactId = mode === 'complete' ? context.task!.contactId : input.contactId;
    if (contactId && context.contact?.id !== contactId) throw new ApiError(409);
    const parents = { application, contact: contactId ? ref(context.contact!) : null };
    return commandSchema.parse(mode === 'task' ? { operation: 'save_task', target: { clientId: crypto.randomUUID() }, parents, data: { title: input.title, dueDate: input.date } } : { operation: 'complete_task', task: ref(context.task!), parents, completedDate: input.date });
  }
  if (mode === 'correction' && (!input.reason.trim() || !input.proof.trim())) throw new ApiError(400);
  const data = { kind: input.kind, state: input.state, occurredDate: input.date, resultText: nullable(input.result), scoreValue: input.score.trim() ? Number(input.score) : null, scoreUnit: nullable(input.unit), sourceText: nullable(input.source), evidence: input.proof.trim() ? evidence(input.proof) : null };
  return commandSchema.parse(mode === 'event' ? { operation: 'record_event', clientId: crypto.randomUUID(), application, data } : { operation: 'correct_event', clientId: crypto.randomUUID(), application, eventId: context.event!.id, replacement: data, reason: input.reason, evidence: evidence(input.proof) });
}

/** Independent raw input and immutable submitted intent survive route/auth remounts. */
function activityDraft(runtime: AppRuntime, mode: Mode, initial: Context) {
  let base = initial; let latest: Context | undefined; let disposed = false;
  const generation = runtime.auth.getSnapshot().generation;
  const alive = () => !disposed && runtime.auth.getSnapshot().generation === generation;
  const active = () => alive() && runtime.auth.getSnapshot().status === 'authenticated';
  let state = { input: inputFrom(mode, initial), dirty: false, uncertain: false, canonicalId: initial.detail.application.canonicalApplicationId, intent: null as ReturnType<typeof createSaveIntent<Command, Result>> | null, error: '', busy: false, revising: false, revisionRequested: false };
  const listeners = new Set<() => void>(); let disconnect = () => {};
  const patch = (changes: Partial<typeof state>) => { state = { ...state, ...changes }; listeners.forEach((fn) => fn()); };
  const read = async () => {
    const detail = await readDetail(runtime, initial.detail.application.id);
    const contactId = mode === 'contact' ? initial.contact?.id : mode === 'complete' ? initial.task?.contactId : state.input.contactId;
    const contact = contactId ? await runtime.api.read<DetailContact>(`/api/v1/contacts/${contactId}`) : undefined;
    const task = initial.task ? detail.tasks.find((task) => task.id === initial.task!.id) : undefined;
    const event = initial.event ? detail.events.find((event) => event.id === initial.event!.id) : undefined;
    if (initial.task && !task || initial.event && !event) throw new ApiError(404);
    if (!active()) throw new ApiError(401);
    latest = { detail, contact, task, event };
    patch({ canonicalId: detail.application.canonicalApplicationId });
    return { versions: { [detail.application.id]: detail.application.version, ...(contact ? { [contact.id]: contact.version } : {}), ...(task ? { [task.id]: task.version } : {}) }, fields: comparable(mode, inputFrom(mode, latest)) };
  };
  return { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    edit: (values: Partial<Input>, contact?: DetailContact) => { patch({ input: { ...state.input, ...values }, dirty: true, error: '' }); if (contact) base = { ...base, contact }; },
    begin: () => {
      if (!active() || state.busy) return;
      if (state.intent) { if (mode === 'contact' || !state.canonicalId || state.uncertain) void state.intent.save(); return; }
      if (mode !== 'contact' && state.canonicalId) return;
      try {
        const intent = createSaveIntent<Command, Result>({ auth: runtime.auth, api: runtime.api, draft: command(mode, state.input, base), readCurrent: read });
        disconnect = intent.subscribe(() => { const status = intent.getSnapshot().status; patch({ uncertain: status === 'unavailable' ? true : ['saved', 'conflict'].includes(status) ? false : state.uncertain }); }); patch({ intent, error: '' }); void intent.save();
      } catch { patch({ error: 'Confira os campos. Informe uma ação, nota numérica e links HTTP(S) válidos; correções exigem motivo e evidência.' }); }
    },
    revise: async () => {
      if (!active() || !state.intent || state.busy) return;
      patch({ busy: true, revisionRequested: true, revising: false, error: '' });
      const outcome = await state.intent.refresh();
      if (alive()) patch({ busy: false, revising: active() && outcome.status === 'ready', error: active() && outcome.status !== 'ready' ? 'Não foi possível reler. Seus dados e a intenção original foram mantidos.' : '' });
    },
    reapply: (selected: readonly string[]) => {
      if (!latest || !state.intent || !active() || mode !== 'contact' && latest.detail.application.canonicalApplicationId) throw new ApiError(409);
      const next = inputFrom(mode, latest);
      for (const key of fieldsFor(mode)) if (selected.includes(labels[key]!)) Object.assign(next, { [key]: state.input[key] });
      if (selected.includes(labels.date!)) next.dateEditor = state.input.dateEditor;
      state.intent.reapply(command(mode, next, latest)); base = latest;
      patch({ input: next, uncertain: false, revising: false, revisionRequested: false });
    },
    dispose: () => { disposed = true; disconnect(); state.intent?.dispose(); state = { input: inputFrom(mode, { detail: initial.detail }), dirty: false, uncertain: false, canonicalId: null, intent: null, error: '', busy: false, revising: false, revisionRequested: false }; latest = undefined; listeners.clear(); },
  };
}

interface Props { runtime: AppRuntime; detail: Detail; mode?: Mode; event?: DetailEvent; task?: DetailTask; contact?: DetailContact; contacts?: DetailContact[]; canonicalId?: string | null; onSaved?(): void; onUseContact?(contact: DetailContact): void }
export function ActivityForm({ runtime, detail, mode = 'event', event, task, contact, contacts = detail.contacts, canonicalId, onSaved, onUseContact }: Props) {
  const key = `activity:${detail.application.id}:${mode}:${event?.id ?? task?.id ?? contact?.id ?? 'new'}`;
  const [revision, setRevision] = useState(0);
  return <ActivityEditor key={`${key}:${revision}`} {...{ runtime, detail, mode, event, task, contact, contacts, canonicalId, onSaved, onUseContact }} draftKey={key} onReset={() => { runtime.abandonDraft(key); setRevision((n) => n + 1); }} />;
}
function ActivityEditor({ runtime, detail, mode = 'event', event, task, contact, contacts = [], canonicalId, onSaved, onUseContact, draftKey, onReset }: Props & { draftKey: string; onReset(): void }) {
  const [draft] = useState(() => runtime.retainDraft(draftKey, () => activityDraft(runtime, mode, { detail, event, task, contact })));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [validDate, setValidDate] = useState(true); const [conflictOpen, setConflictOpen] = useState(true);
  const f = state.input; const save = state.intent?.getSnapshot();
  const revising = state.revising && !!save?.current;
  const blockedCanonical = mode === 'contact' ? null : state.canonicalId ?? canonicalId ?? detail.application.canonicalApplicationId;
  const locked = !!blockedCanonical || !!save && !revising || state.busy;
  const title = mode === 'event' ? 'Registrar atividade' : mode === 'correction' ? 'Corrigir interpretação' : mode === 'task' ? 'Criar próxima ação' : mode === 'complete' ? `Concluir: ${task!.title}` : contact ? 'Editar contato' : 'Criar contato opcional';
  const button = mode === 'event' ? 'Salvar atividade' : mode === 'correction' ? 'Salvar correção' : mode === 'task' ? 'Salvar próxima ação' : mode === 'complete' ? 'Confirmar conclusão' : 'Salvar contato';
  const field = (key: keyof Input, multiline = false) => <label>{labels[key]}{multiline ? <textarea value={String(f[key])} onChange={(e) => draft.edit({ [key]: e.target.value })} /> : <input value={String(f[key])} onChange={(e) => draft.edit({ [key]: e.target.value })} />}</label>;
  const dated = mode !== 'contact';
  const dateLabel = mode === 'task' ? 'Prazo da ação' : mode === 'complete' ? 'Data da conclusão' : 'Data do acontecimento';
  const canSave = !dated || validDate;
  const recovery = blockedCanonical && <p className="application-notice">Este registro foi unido a um registro canônico. O rascunho e a intenção original permanecem aqui para consulta. Não serão reaplicados ao alias nem transferidos automaticamente. <Link to={`/vagas/${blockedCanonical}`}>Abrir registro canônico</Link></p>;
  if (blockedCanonical && !state.dirty && !save) return mode === 'complete' ? <p>Nenhum rascunho local de conclusão. Abra o registro canônico para acompanhar.</p> : null;
  return <section className="application-editor activity-editor" aria-label={title}><h3>{title}</h3>
    {recovery}
    {mode === 'event' && <p>Convite, conclusão e reaproveitamento são fatos distintos. Registre o reaproveitamento no relato. Nota informada não confirma aprovação ou novo envio.</p>}
    {mode === 'contact' && !contact && <p>Contato independente e opcional. Ele só será vinculado ao processo se você o escolher em uma próxima ação. Nenhuma identidade é deduzida.</p>}
    {mode === 'correction' && <p>O original permanece no histórico. Informe a nova interpretação, o motivo e a evidência da correção.</p>}
    <form onSubmit={(e) => { e.preventDefault(); if (!canSave || blockedCanonical) return; if (revising) setConflictOpen(true); else draft.begin(); }}>
      <fieldset disabled={locked}><legend>{title}</legend>
        {(mode === 'event' || mode === 'correction') && <><div className="application-grid"><label>Tipo de atividade<select aria-label="Tipo de atividade" value={f.kind} onChange={(e) => draft.edit({ kind: e.target.value as EventKind })}>{Object.entries(eventKinds).filter(([kind]) => !['envio_confirmado', 'correcao'].includes(kind)).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label><label>Situação da atividade<select aria-label="Situação da atividade" value={f.state} onChange={(e) => draft.edit({ state: e.target.value as EventState })}>{Object.entries(eventStates).map(([state, label]) => <option key={state} value={state}>{label}</option>)}</select></label></div>{field('result', true)}<div className="application-grid">{field('score')}{field('unit')}</div>{field('source')}{field('proof', true)}{mode === 'correction' && field('reason', true)}</>}
        {mode === 'task' && <>{field('title')}<label>Contato opcional<select aria-label="Contato opcional" value={f.contactId} onChange={(e) => draft.edit({ contactId: e.target.value }, contacts.find((contact) => contact.id === e.target.value))}><option value="">Sem contato</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name || 'Contato sem nome'} · {c.id.slice(0, 8)}</option>)}</select></label></>}
        {mode === 'contact' && <>{field('name')}{field('notes', true)}{field('links', true)}<p>Um novo link HTTP(S) por linha. Nome pode permanecer vazio.</p></>}
        {dated && <DateField label={dateLabel} value={f.date} editorState={f.dateEditor} onChange={(date) => draft.edit({ date })} onEditorChange={(dateEditor) => draft.edit({ dateEditor })} onValidityChange={setValidDate} />}
        {(mode === 'task' || mode === 'complete') && <p>Prazo e conclusão não enviam notificações nem sincronizam calendário. Data desconhecida permanece desconhecida.</p>}
        {!blockedCanonical && !save && <button disabled={!canSave}>{button}</button>}
        {!blockedCanonical && revising && <button disabled={!canSave}>Preparar intenção corrigida</button>}
      </fieldset>
    </form>
    {state.error && <p role="alert">{state.error}</p>}{save?.error && <p role="alert">{save.error.message}</p>}
    {save?.status === 'saving' && <p role="status">Salvando registro…</p>}
    {blockedCanonical && state.uncertain && save && ['editing', 'error', 'unavailable'].includes(save.status) && <><p>A resposta original foi incerta. Repetir consulta a mesma intenção e chave para recuperar o resultado; não prepara uma nova edição no alias.</p><button onClick={draft.begin}>Repetir intenção original</button></>}
    {!blockedCanonical && save && ['editing', 'error', 'unavailable'].includes(save.status) && !revising && <button disabled={!canSave || state.busy} onClick={draft.begin}>{save.status === 'editing' ? 'Salvar intenção preparada' : 'Repetir intenção original'}</button>}
    {!blockedCanonical && (save?.error?.status === 400 || state.revisionRequested && !revising) && <button disabled={state.busy} onClick={() => { setConflictOpen(false); void draft.revise(); }}>Revisar registro recusado</button>}
    {save && ['conflict', 'refresh-required'].includes(save.status) && !state.revisionRequested && <button onClick={() => setConflictOpen(true)}>Comparar edição</button>}
    {save && (['conflict', 'refresh-required'].includes(save.status) && !state.revisionRequested || revising) && conflictOpen && <ConflictDialog local={comparable(mode, f)} current={save.current} reapplyBlocked={!!blockedCanonical} onRefresh={() => state.intent!.refresh()} onReapply={(selected) => { if (!canSave) throw new ApiError(400); draft.reapply(selected); setConflictOpen(false); }} onClose={() => setConflictOpen(false)}>{recovery}</ConflictDialog>}
    {save?.status === 'saved' && <><p role="status">Registro salvo.</p>{onSaved && <button onClick={onSaved}>Atualizar histórico salvo</button>}{mode === 'contact' && save.result?.contact && onUseContact && <button onClick={() => onUseContact(save.result!.contact!)}>Disponibilizar contato nas próximas ações</button>}{mode !== 'complete' && mode !== 'correction' && <button onClick={onReset}>{mode === 'contact' && contact ? 'Editar novamente' : 'Preparar outro registro'}</button>}</>}
  </section>;
}
