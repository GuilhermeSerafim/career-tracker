import { useState, useSyncExternalStore } from 'react';
import { ApiError, type CurrentVersion } from '../../lib/api';
import { ConflictDialog } from '../../components/ConflictDialog';
import type { Editor } from './editor';

export function EditorActions<F, B>({ editor, compare, button, valid = true, onSaved, onReapplied }: { editor: Editor<F, B>; compare(fields: F): CurrentVersion['fields']; button: string; valid?: boolean; onSaved?(): void; onReapplied?(): void }) {
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const save = state.intent?.getSnapshot();
  const [dialog, setDialog] = useState(false);
  const compareNeeded = state.needsRead || save && ['conflict', 'refresh-required', 'forbidden'].includes(save.status);
  const replay = compareNeeded && editor.canReplayOriginal() ? <><p>A leitura atual foi autorizada. Recupere o resultado da tentativa anterior repetindo exatamente a intenção original.</p><button type="button" onClick={() => { setDialog(false); void editor.replayOriginal(); }}>Repetir intenção original</button></> : null;
  return <>
    {state.error && <p role="alert">{state.error}</p>}{save?.error && <p role="alert">{save.error.message}</p>}
    {!compareNeeded && (!save || ['editing', 'error', 'unavailable'].includes(save.status)) && <button type="button" disabled={!valid} onClick={() => { void editor.save(); }}>{!save ? button : save.status === 'editing' ? 'Salvar intenção preparada' : 'Repetir intenção original'}</button>}
    {save?.status === 'saving' && <p role="status">Salvando…</p>}
    {compareNeeded && <button type="button" onClick={() => setDialog(true)}>Comparar edição</button>}
    {save?.status === 'forbidden' && <p>O salvamento foi recusado. Sua edição foi mantida. Após restabelecer o acesso, use Comparar edição e releia a versão atual para verificar a autorização.</p>}
    {!dialog && replay}
    {dialog && <ConflictDialog local={compare(state.fields)} current={state.current} onRefresh={editor.refresh} onReapply={(selected) => { if (!valid && !editor.preparesNewDraft()) throw new ApiError(400); editor.reapply(selected); onReapplied?.(); setDialog(false); }} onClose={() => setDialog(false)}>
      {replay}
      {editor.preparesNewDraft() && <p>O lote já foi fechado. Reaplicar os campos selecionados prepara um rascunho de nova revisão sobre a versão atual. Complete o motivo e a evidência, confira o balanço e salve separadamente. A versão existente será preservada.</p>}
    </ConflictDialog>}
    {save?.status === 'saved' && <><p role="status">Registro salvo.</p>{onSaved && <button type="button" onClick={onSaved}>Atualizar dados salvos</button>}</>}
  </>;
}
