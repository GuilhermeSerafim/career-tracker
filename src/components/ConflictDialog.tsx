import { ApiError } from '../lib/api';
import type { CurrentVersion, RefreshResult } from '../lib/api';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './session.css';

export interface ConflictDialogProps {
  local: CurrentVersion['fields'];
  current: CurrentVersion | null;
  changedFields?: readonly string[];
  onRefresh: () => Promise<RefreshResult>;
  onReapply: (selectedFields: readonly string[]) => void;
  onClose: () => void;
  reapplyBlocked?: boolean;
  children?: ReactNode;
}
/** Labels should be user-facing field names; never pass private URLs as labels. */
export function ConflictDialog({ local, current, changedFields, onRefresh, onReapply, onClose, reapplyBlocked = false, children }: ConflictDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(); const descriptionId = useId();
  const [selection, setSelection] = useState<{ basis: CurrentVersion | null; fields: string[] }>({ basis: null, fields: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const selected = selection.basis === current ? selection.fields : [];
  useEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', '');
    node.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (typeof node.close === 'function') node.close(); previous?.focus(); };
  }, []);
  const refresh = async () => {
    setBusy(true); setError(null); setSelection({ basis: null, fields: [] });
    try { const outcome = await onRefresh(); if (outcome.status === 'error') setError(outcome.error); }
    catch { setError(new ApiError(503)); }
    finally { setBusy(false); }
  };
  return <dialog className="session-ui session-conflict" ref={dialog} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current!.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <h2 id={titleId}>Conflito de edição</h2>
    <p id={descriptionId}>Sua edição foi mantida. Releia a versão atual, compare e escolha os campos que deseja reaplicar. Nada será salvo automaticamente.</p>
    {children}
    {changedFields?.length ? <p>Campos alterados: {changedFields.join(', ')}</p> : null}
    <button type="button" disabled={busy} onClick={() => { void refresh(); }}>{busy ? 'Relendo…' : 'Reler versão atual'}</button>
    {busy && <p role="status">Relendo a versão atual…</p>}
    {!current && !busy && !error && <p role="status">Aguardando releitura autorizada da versão atual.</p>}
    {current && <p>Versões atuais: {Object.values(current.versions).join(', ')}</p>}
    <div className="session-comparison" role="region" aria-label="Comparação dos campos" tabIndex={0}>
    <table><caption>Comparação da edição</caption><thead><tr><th scope="col">Campo</th><th scope="col">Sua edição</th><th scope="col">Versão atual</th><th scope="col">Escolha</th></tr></thead>
      <tbody>{Object.entries(local).map(([field, value]) => <tr key={field}>
        <th scope="row">{field}</th><td>{String(value ?? 'Não informado')}</td><td>{current ? String(current.fields[field] ?? 'Não informado') : 'Releia para comparar'}</td>
        <td><label><input type="checkbox" disabled={!current || busy || reapplyBlocked} checked={selected.includes(field)} onChange={(event) => {
          setSelection({ basis: current, fields: event.target.checked ? [...selected, field] : selected.filter((item) => item !== field) });
        }} />Reaplicar {field}</label></td>
      </tr>)}</tbody></table></div>
    {error && <><p role="alert">{error.message}</p>{error.requestId && <p>Referência: {error.requestId}</p>}</>}
    <button type="button" disabled={!current || busy || !selected.length || reapplyBlocked} onClick={() => {
      try { onReapply(selected); } catch { setError(new ApiError(409)); }
    }}>Reaplicar campos selecionados</button>
    <button type="button" onClick={onClose}>Fechar e manter edição</button>
  </dialog>;
}
