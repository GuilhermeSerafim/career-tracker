import { useState, useSyncExternalStore } from 'react';
import type { AppRuntime } from '../../app/runtime';
import type { ApplicationResult } from '../../../shared/application-results';
import type { Command } from '../../../shared/commands';
import { createSaveIntent } from '../../lib/api';
import { nullable, split } from './application-data';

function resumeDraft(runtime: AppRuntime) {
  let state = { open: false, label: '', language: '', stack: '', localRef: '', error: '', intent: null as ReturnType<typeof createSaveIntent<Command, ApplicationResult>> | null };
  const listeners = new Set<() => void>(); let unsubscribe = () => {};
  const patch = (changes: Partial<typeof state>) => { state = { ...state, ...changes }; listeners.forEach((fn) => fn()); };
  return { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, patch,
    save: () => {
      if (state.intent) { void state.intent.save(); return; }
      try {
        const intent = createSaveIntent<Command, ApplicationResult>({ auth: runtime.auth, api: runtime.api,
          draft: { operation: 'create_resume_ref', clientId: crypto.randomUUID(), data: { label: nullable(state.label), language: nullable(state.language), stack: split(state.stack), localRef: nullable(state.localRef) } },
          readCurrent: async () => { await runtime.api.read('/api/v1/health'); return { versions: {}, fields: {} }; } });
        unsubscribe = intent.subscribe(() => patch({})); patch({ intent }); void intent.save();
      } catch { patch({ error: 'Confira os metadados do currículo.' }); }
    },
    dispose: () => { unsubscribe(); state.intent?.dispose(); state = { open: false, label: '', language: '', stack: '', localRef: '', error: '', intent: null }; listeners.clear(); },
  };
}
export function ResumeCreator({ runtime, draftKey, onSelect }: { runtime: AppRuntime; draftKey: string; onSelect(id: string): void }) {
  const [draft] = useState(() => runtime.retainDraft(`${draftKey}:resume`, () => resumeDraft(runtime)));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const save = state.intent?.getSnapshot();
  if (!state.open) return <button type="button" onClick={() => draft.patch({ open: true })}>Adicionar referência de currículo</button>;
  return <section className="resume-creator" aria-label="Nova referência de currículo"><h3>Currículo que você enviou</h3><p>Somente uma referência. Nenhum arquivo será lido ou enviado.</p>
    <fieldset disabled={!!save}><div className="application-grid">{(['label', 'language', 'stack', 'localRef'] as const).map((key) => <label key={key}>{{ label: 'Nome do currículo', language: 'Idioma do currículo', stack: 'Stack do currículo', localRef: 'Referência local (opcional)' }[key]}<input value={state[key]} onChange={(e) => draft.patch({ [key]: e.target.value })} /></label>)}</div></fieldset>
    {!save && <button type="button" disabled={!state.label.trim()} onClick={draft.save}>Criar referência</button>}
    {state.error && <p role="alert">{state.error}</p>}{save?.error && <p role="alert">{save.error.message}</p>}
    {save?.status === 'saving' && <p role="status">Criando referência…</p>}
    {save && ['error', 'unavailable', 'editing'].includes(save.status) && <button type="button" onClick={draft.save}>Repetir criação original</button>}
    {save?.status === 'refresh-required' && <button type="button" onClick={() => { void state.intent!.refresh(); }}>Reler acesso ao currículo</button>}
    {save?.status === 'saved' && save.result?.resumeRef && <><p role="status">Referência criada: {save.result.resumeRef.label}</p><button type="button" onClick={() => { onSelect(save.result!.resumeRef!.id); }}>Selecionar este currículo enviado</button></>}
  </section>;
}
