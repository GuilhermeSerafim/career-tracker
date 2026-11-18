import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import type { AppRuntime } from '../../app/runtime';
import type { Command } from '../../../shared/commands';
import type { ApplicationResult } from '../../../shared/application-results';
import { ApiError, createSaveIntent } from '../../lib/api';
import type { CurrentVersion } from '../../lib/api';
import { ConflictDialog } from '../../components/ConflictDialog';
import { DateField } from '../../components/DateField';
import type { DateEditorState } from '../../components/DateField';
import type { DateValue, CycleRelation } from '../../../shared/model';
import { evidence, readDetail, stages, unknownDate } from './application-data';
import type { Application, Detail } from './application-data';

type Mode = 'archive_application' | 'restore_application' | 'invalidate_submission' | 'resolve_duplicate' | 'confirm_submission' | 'keep_distinct';
type Input = { mode: Mode; target: string; reason: string; proof: string; date: DateValue; dateEditor?: DateEditorState; relation: CycleRelation };
type Snapshot = { source: Detail; target?: Detail; batches: { id: string; expectedVersion: number; status?: string }[] };
const eligible = (a: Application) => Number(a.submissionStatus === 'confirmado' && a.countingEligible && !a.canonicalApplicationId);
const ref = (a: { id: string; version: number }) => ({ id: a.id, expectedVersion: a.version });
const actionFields = (input: Input): CurrentVersion['fields'] => ({ 'Operação': input.mode, 'Destino canônico': input.target, 'Motivo': input.reason, 'Evidência': input.proof, 'Data': JSON.stringify(input.date), 'Relação com o ciclo': input.relation });
async function readSnapshot(runtime: AppRuntime, id: string, input: Input): Promise<Snapshot> {
  const source = await readDetail(runtime, id);
  const target = input.mode === 'resolve_duplicate' ? await readDetail(runtime, input.target) : undefined;
  if (target && target.application.id === source.application.id) throw new ApiError(400);
  const batches = new Map<string, { id: string; expectedVersion: number; status?: string }>();
  for (const batch of [...source.affectedBatches, ...(target?.affectedBatches ?? [])]) {
    if (batches.has(batch.id) && batches.get(batch.id)!.expectedVersion !== batch.version) throw new ApiError(409);
    batches.set(batch.id, { ...ref(batch), ...('status' in batch ? { status: String(batch.status) } : {}) });
  }
  return { source, target, batches: [...batches.values()] };
}
function actionCommand(input: Input, current: Snapshot): Command {
  const application = ref(current.source.application);
  if (input.mode === 'archive_application' || input.mode === 'restore_application') return { operation: input.mode, application };
  if (!input.proof.trim()) throw new ApiError(400);
  if (input.mode === 'confirm_submission') return { operation: input.mode, application, submittedDate: input.date, cycleRelation: input.relation, evidence: evidence(input.proof) };
  if (!input.reason.trim()) throw new ApiError(400);
  if (input.mode === 'keep_distinct') return { operation: 'record_event', clientId: crypto.randomUUID(), application, data: { kind: 'nota', state: 'informado', occurredDate: unknownDate, resultText: input.reason, scoreValue: null, scoreUnit: null, sourceText: null, evidence: evidence(input.proof) } };
  const correction = { operation: input.mode, application, affectedBatches: current.batches.map(({ id, expectedVersion }) => ({ id, expectedVersion })), reason: input.reason, evidence: evidence(input.proof) };
  return input.mode === 'resolve_duplicate' ? { ...correction, operation: 'resolve_duplicate', canonicalApplication: ref(current.target!.application) } : { ...correction, operation: 'invalidate_submission' };
}
function actionsDraft(runtime: AppRuntime, detail: Detail) {
  let state = { open: false, input: { mode: 'invalidate_submission', target: '', reason: '', proof: '', date: unknownDate, relation: 'unknown' } as Input, preview: null as Snapshot | null, busy: false, error: '', intent: null as ReturnType<typeof createSaveIntent<Command, ApplicationResult>> | null };
  let latest: Snapshot | null = null; const listeners = new Set<() => void>(); let unsubscribe = () => {};
  const patch = (changes: Partial<typeof state>) => { state = { ...state, ...changes }; listeners.forEach((fn) => fn()); };
  const read = async () => { latest = await readSnapshot(runtime, detail.application.id, state.input); return latest; };
  return { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    edit: (input: Partial<Input>) => patch({ input: { ...state.input, ...input }, preview: null, error: '' }),
    open: (mode?: Mode) => patch({ open: true, input: { ...state.input, mode: mode ?? 'invalidate_submission' }, preview: null }),
    preview: async () => { patch({ busy: true, error: '', preview: null }); try { patch({ preview: await read() }); } catch { patch({ error: 'Não foi possível conferir o impacto atual. Verifique o destino e releia; nenhuma alteração foi enviada.' }); } finally { patch({ busy: false }); } },
    save: () => {
      if (state.intent) { void state.intent.save(); return; }
      if (!state.preview) return;
      try {
        const intent = createSaveIntent<Command, ApplicationResult>({ auth: runtime.auth, api: runtime.api, draft: actionCommand(state.input, state.preview), readCurrent: async () => {
          const current = await read();
          return { versions: { [current.source.application.id]: current.source.application.version, ...(current.target ? { [current.target.application.id]: current.target.application.version } : {}), ...Object.fromEntries(current.batches.map((b) => [b.id, b.expectedVersion])) }, fields: { ...actionFields(state.input), 'Versão da candidatura': current.source.application.version, 'Histórico elegível': eligible(current.source.application) } };
        } });
        unsubscribe = intent.subscribe(() => patch({})); patch({ intent }); void intent.save();
      } catch { patch({ error: 'Informe motivo, evidência e um destino válido antes de confirmar.' }); }
    },
    reapply: (selected: readonly string[]) => {
      // Operation, target and proof constitute one deliberate correction, never a silent partial union.
      if (!latest || !state.intent || !selected.includes('Operação')) throw new ApiError(409);
      const all = Object.keys(actionFields(state.input));
      if (!all.every((key) => selected.includes(key))) throw new ApiError(409);
      state.intent.reapply(actionCommand(state.input, latest)); patch({ preview: latest });
    },
    dispose: () => { unsubscribe(); state.intent?.dispose(); state = { ...state, input: { mode: 'invalidate_submission', target: '', reason: '', proof: '', date: unknownDate, relation: 'unknown' }, preview: null, intent: null }; listeners.clear(); },
  };
}
export function ApplicationActions({ runtime, detail, onReload }: { runtime: AppRuntime; detail: Detail; onReload(): void }) {
  const [draft] = useState(() => runtime.retainDraft(`application-actions:${detail.application.id}`, () => actionsDraft(runtime, detail)));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [validDate, setValidDate] = useState(true); const [showConflict, setShowConflict] = useState(true);
  const save = state.intent?.getSnapshot(); const i = state.input; const a = detail.application;
  const valid = i.mode !== 'confirm_submission' || validDate;
  const archive = i.mode === 'archive_application' || i.mode === 'restore_application';
  const before = state.preview ? eligible(state.preview.source.application) + (state.preview.target ? eligible(state.preview.target.application) : 0) : 0;
  const after = i.mode === 'invalidate_submission' || i.mode === 'resolve_duplicate' ? before - (state.preview ? eligible(state.preview.source.application) : 0) : i.mode === 'confirm_submission' ? (state.preview?.source.application.countingEligible && !state.preview.source.application.canonicalApplicationId ? 1 : 0) : before;
  return <section className="application-editor application-actions" aria-label="Ações do registro"><h2>Ações do registro</h2><p>Estas ações usam o registro salvo. Edições pendentes no formulário continuam no rascunho.</p>
    {!state.open && <><button onClick={() => { draft.open(a.archivedAt ? 'restore_application' : 'archive_application'); void draft.preview(); }}>{a.archivedAt ? 'Restaurar registro' : 'Arquivar registro'}</button><button onClick={() => draft.open()}>Corrigir contagem ou duplicata</button>{a.submissionStatus !== 'confirmado' && <button onClick={() => draft.open('confirm_submission')}>Confirmar envio realizado</button>}</>}
    {state.open && <><fieldset disabled={!!save || state.busy}><legend>Decisão explícita</legend>
      <label>Correção<select aria-label="Correção" value={i.mode} onChange={(e) => draft.edit({ mode: e.target.value as Mode })}><option value="invalidate_submission">Invalidar contagem de envio</option><option value="resolve_duplicate">Resolver duplicata com outro registro</option><option value="keep_distinct">Manter registros distintos com evidência</option><option value="archive_application">Arquivar</option><option value="restore_application">Restaurar</option>{a.submissionStatus !== 'confirmado' && <option value="confirm_submission">Confirmar envio realizado</option>}</select></label>
      {i.mode === 'resolve_duplicate' && <><label>ID do registro canônico<input value={i.target} onChange={(e) => draft.edit({ target: e.target.value })} /></label><p>Confira o UUID no endereço do registro. Trilhas ou ocorrências diferentes não podem ser unidas; mantenha-as distintas com evidência.</p></>}
      {!archive && <><label>Motivo da correção<textarea value={i.reason} onChange={(e) => draft.edit({ reason: e.target.value })} /></label><label>Evidência da correção<textarea value={i.proof} onChange={(e) => draft.edit({ proof: e.target.value })} /></label></>}
      {i.mode === 'confirm_submission' && <><DateField label="Data confirmada do envio" value={i.date} editorState={i.dateEditor} onChange={(date) => draft.edit({ date })} onEditorChange={(dateEditor) => draft.edit({ dateEditor })} onValidityChange={setValidDate} /><label>Relação confirmada com o ciclo<select aria-label="Relação confirmada com o ciclo" value={i.relation} onChange={(e) => draft.edit({ relation: e.target.value as CycleRelation })}><option value="unknown">Desconhecida — fora do ciclo</option><option value="before_reset">Anterior ao marco</option><option value="after_reset">Após o marco</option></select></label></>}
      <button type="button" disabled={!valid} onClick={() => { void draft.preview(); }}>Conferir impacto atual</button>
    </fieldset>
    {state.busy && <p role="status">Conferindo versões e contagens…</p>}{state.error && <p role="alert">{state.error}</p>}
    {state.preview && <section className="application-notice" aria-label="Impacto da decisão"><p>{state.preview.source.application.displayId}{state.preview.target ? ` → ${state.preview.target.application.displayId}` : ''} · Histórico: {before} → {after} candidatura(s) elegível(is) entre os registros envolvidos.</p><p>Etapa preservada: {stages[state.preview.source.application.stage]}. {archive ? 'Arquivamento é reversível. Histórico e ações pendentes são preservados.' : 'A correção será auditada; IDs e evidências permanecem no histórico.'}</p><p>{state.preview.batches.length} lote(s) vinculado(s). {archive || i.mode === 'keep_distinct' ? 'A elegibilidade dos lotes será preservada.' : 'Lotes fechados mantêm a população congelada e recebem pendência de retificação quando afetados; lotes abertos atualizam a elegibilidade.'}</p>{!save && <button disabled={!valid} onClick={draft.save}>{archive ? 'Confirmar arquivamento' : 'Confirmar correção'}</button>}</section>}
    {save?.status === 'saving' && <p role="status">Salvando decisão…</p>}{save?.error && <p role="alert">{save.error.message}</p>}
    {save && ['editing', 'error', 'unavailable'].includes(save.status) && <button onClick={draft.save}>Repetir decisão original</button>}
    {save?.status === 'refresh-required' && <button onClick={() => { void state.intent!.refresh(); }}>Reler acesso e decisão</button>}
    {save && ['conflict', 'refresh-required'].includes(save.status) && <><p>Releia e selecione todos os campos da decisão para reaplicá-la sobre as versões atuais.</p><button onClick={() => setShowConflict(true)}>Comparar decisão</button>{showConflict && <ConflictDialog local={actionFields(i)} current={save.current} onRefresh={() => state.intent!.refresh()} onReapply={(selected) => { draft.reapply(selected); setShowConflict(false); }} onClose={() => setShowConflict(false)} />}</>}
    {save?.status === 'saved' && <><p role="status">Decisão salva. <Link to="/vagas">Consultar lista atual</Link></p><button onClick={onReload}>Atualizar registro</button></>}
    </>}
    {!!detail.tasks.filter((task) => task.status === 'pending').length && <p>{detail.tasks.filter((task) => task.status === 'pending').length} ação(ões) pendente(s) vinculada(s). Arquivar não as conclui.</p>}
  </section>;
}
