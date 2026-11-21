import { useEffect, useRef, useState } from 'react';
import type { AppRuntime } from '../../app/runtime';
import { ApiError } from '../../lib/api';
import { Exports } from '../settings/SettingsPage';
import { applyHistorical, previewHistorical } from './historical-import';

function recovery(error: unknown) {
  const status = error instanceof ApiError ? error.status : 400;
  if (status === 413) return 'O pacote (até 2 MB) ou a exportação (até 4 MB) excedeu o limite da tela. Continue pelo procedimento de importação local privada.';
  if (status === 401 || status === 403 || status === 0) return 'Confira a sessão e a conta de destino. Entre com a conta proprietária e selecione o mesmo arquivo.';
  if (status === 409) return 'O destino, uma versão ou a identidade do pacote divergiu. Confira a conta e o arquivo original antes de continuar.';
  if (status === 400) return 'Pacote inválido. Confira o formato, as fontes, as candidaturas e os membros da revisão.';
  return 'O servidor não confirmou a etapa. Aguarde e selecione novamente o mesmo arquivo para retomar.';
}
export function HistoricalImportPanel({ runtime, disabled }: { runtime: AppRuntime; disabled: boolean }) {
  const selection = useRef(0);
  useEffect(() => () => { selection.current++; }, []);
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof previewHistorical>> | null>(null);
  const [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState(''), [error, setError] = useState(''), [done, setDone] = useState(false);
  const select = async (file: File | undefined) => {
    const id = ++selection.current;
    setPrepared(null); setError(''); setStatus(''); setConfirmed(false); setDone(false);
    if (!file) return;
    setBusy(true); setStatus('Conferindo o pacote…');
    try {
      const checked = await previewHistorical(runtime, file);
      if (id === selection.current) setPrepared(checked);
    } catch (e) { if (id === selection.current) setError(recovery(e)); }
    finally { if (id === selection.current) { setBusy(false); setStatus(''); } }
  };
  const apply = async () => {
    if (!prepared || !confirmed || busy || disabled || !window.confirm('Aplicar o pacote histórico conferido nesta conta?')) return;
    const current = selection.current;
    const active = () => selection.current === current;
    setBusy(true); setError('');
    try {
      await applyHistorical(runtime, prepared, message => { if (active()) setStatus(message); }, active);
      if (active()) { setDone(true); void runtime.query.invalidateQueries(); }
    } catch (e) { if (active()) { setError(recovery(e)); setPrepared(null); setConfirmed(false); } }
    finally { if (active()) { setBusy(false); setStatus(''); } }
  };
  return <details className="csv-panel"><summary>Importar pacote histórico</summary>
    <p>Selecione o JSON preparado para esta conta. Para retomar uma importação interrompida, selecione o mesmo arquivo.</p>
    <label>Pacote histórico preparado (.json)<input type="file" accept=".json,application/json" disabled={busy || disabled} onChange={e => {
      const file = e.target.files?.[0]; e.target.value = ''; void select(file);
    }} /></label>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    {prepared && !done && <><h2>Prévia do pacote histórico</h2>
      <p>{prepared.result.rows} candidaturas · {prepared.result.sources} fontes · 1 revisão com {prepared.result.members} membros.</p>
      <p>SHA-256 do arquivo: <code className="historical-digest">{prepared.result.digest}</code></p>
      {prepared.result.resume && <p>Importação reconhecida. A confirmação recupera as etapas registradas.</p>}
      {prepared.result.warnings.length > 0 && <><h3>Avisos da preparação</h3><ul>{prepared.result.warnings.map((warning,i) => <li key={i}>{warning}</li>)}</ul></>}
      <div className="csv-approval"><label><input type="checkbox" checked={confirmed} disabled={busy || disabled} onChange={e => setConfirmed(e.target.checked)} /> Conferi a prévia e autorizo a importação do histórico</label>
      <button disabled={!confirmed || busy || disabled} onClick={() => { void apply(); }}>Aplicar pacote histórico</button></div>
    </>}
    {done && prepared && <><p role="status">Importação histórica concluída. {prepared.result.rows} candidaturas e 1 revisão confirmadas.</p><Exports runtime={runtime} /></>}
  </details>;
}
