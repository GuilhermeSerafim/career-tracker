import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppRuntime } from '../../app/runtime';
import { ApiError } from '../../lib/api';
import { createEditor } from '../reviews/editor';
import { EditorActions } from '../reviews/EditorActions';
import { downloadText, TRANSFER_LIMIT, type ImportUnit } from './transfer-client';
import '../reviews/reviews.css';
import { AgentCredentials } from './AgentCredentials';

type Settings = { id: string; version: number; dailyGoal: number; timezone: 'America/Sao_Paulo' };
const compare = (f: { goal: string }) => ({ 'Meta diária': f.goal });
const time = (date: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(date));
export function SettingsPage({ runtime }: { runtime: AppRuntime }) {
  const focus = useCallback((heading: HTMLHeadingElement | null) => heading?.focus(), []);
  const query = useQuery({ queryKey: ['settings'], queryFn: () => runtime.api.read<Settings>('/api/v1/settings') });
  return <div className="settings-page"><section className="page-intro"><p className="eyebrow">Do seu jeito</p><h1 ref={focus} tabIndex={-1}>Configurações</h1><p>Seu ritmo e suas cópias privadas.</p></section>{query.isPending && <p role="status">Carregando configurações…</p>}{query.isError && <><p role="alert">Não foi possível ler suas configurações.</p><button onClick={() => { void query.refetch(); }}>Tentar novamente</button></>}{query.data && <Goal runtime={runtime} settings={query.data} />}<AgentCredentials runtime={runtime} /><Exports runtime={runtime} /><Transfers runtime={runtime} /></div>;
}
function Goal({ runtime, settings }: { runtime: AppRuntime; settings: Settings }) {
  const [editor] = useState(() => runtime.retainDraft('daily-goal', () => createEditor(runtime, {
    fields: { goal: String(settings.dailyGoal) }, basis: settings, read: () => runtime.api.read<Settings>('/api/v1/settings'), fieldsFrom: (b) => ({ goal: String(b.dailyGoal) }), compare, versions: (b) => ({ [b.id]: b.version }),
    select: (local, current, selected) => selected.includes('Meta diária') ? local : current,
    command: (f, b) => ({ operation: 'update_settings', settings: { id: b.id, expectedVersion: b.version }, dailyGoal: Number(f.goal), timezone: 'America/Sao_Paulo' }),
  })));
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const saved = state.intent?.getSnapshot().status === 'saved';
  useEffect(() => { if (saved) { void runtime.query.invalidateQueries({ queryKey: ['today'] }); } }, [saved, runtime]);
  return <section className="review-panel"><h2>Meta de candidaturas</h2><p>Envios confirmados no dia local, em America/Sao_Paulo.</p><label>Meta diária<input type="number" min="1" max="10000" step="1" value={state.fields.goal} disabled={!!state.intent} onChange={(e) => editor.edit({ goal: e.target.value })} /></label><EditorActions editor={editor} compare={compare} button="Salvar meta" valid={Number.isInteger(Number(state.fields.goal)) && Number(state.fields.goal) > 0 && Number(state.fields.goal) <= 10000} onSaved={() => { void runtime.query.invalidateQueries({ queryKey: ['today'] }); void runtime.query.invalidateQueries({ queryKey: ['settings'] }); }} />{saved && <button onClick={() => { void editor.restart(); }}>Editar meta novamente</button>}</section>;
}
export function Exports({ runtime }: { runtime: AppRuntime }) {
  const state = useSyncExternalStore(runtime.transfers.subscribe, runtime.transfers.getSnapshot); const [error, setError] = useState('');
  const download = async (format: 'csv' | 'json') => {
    let receiptId: number | undefined;
    setError(''); try { const received = await runtime.transfers.export(format); receiptId = received.receiptId; if (runtime.auth.getSnapshot().status !== 'authenticated' || runtime.transfers.getSnapshot().receiptId !== receiptId) throw new ApiError(0); downloadText(received.text, `carreira-privada.${format}`, format === 'csv' ? 'text/csv' : 'application/json'); }
    catch (error) { if (receiptId !== undefined) runtime.transfers.downloadFailed(receiptId); setError(error instanceof ApiError && error.status === 413 ? 'A exportação excedeu o limite web de 4 MB. Use o script local export-private.ts para a cópia completa.' : 'Download interrompido ou indisponível. Nenhum novo arquivo salvo foi confirmado.'); }
  };
  return <section className="review-panel"><h2>Exportações privadas</h2><p>JSON completo inclui histórico, evidências, revisões e proveniência. CSV preserva os campos legados e não substitui o JSON de recuperação. Guarde em pasta privada fora do repositório.</p><div className="transfer-controls"><button disabled={state.status === 'receiving'} onClick={() => { void download('json'); }}>Baixar JSON completo</button><button disabled={state.status === 'receiving'} onClick={() => { void download('csv'); }}>Baixar CSV</button></div>{state.status === 'receiving' && <p role="status">Recebendo arquivo…</p>}{error && <p role="alert">{error}</p>}{state.receivedAt && <p>Bytes recebidos em {time(state.receivedAt)}. O navegador não confirma que você salvou o arquivo.</p>}{state.status === 'received' && <button onClick={() => runtime.transfers.confirmSaved(state.receiptId)}>Confirmo que salvei o arquivo em local privado</button>}<p>{state.confirmedAt ? `Último arquivo salvo confirmado por você nesta sessão: ${time(state.confirmedAt)}.` : 'Nenhum arquivo salvo confirmado nesta sessão.'}</p><p>Esta informação é temporária e não representa backup automático nem histórico em outros dispositivos.</p></section>;
}
type Mode = 'csv' | 'restore' | 'unit';
function Transfers({ runtime }: { runtime: AppRuntime }) {
  const transfer = useSyncExternalStore(runtime.transfers.subscribe, runtime.transfers.getSnapshot);
  const selection = useRef(0);
  useEffect(() => () => { selection.current++; }, []);
  const [mode, setMode] = useState<Mode>('csv'); const [report, setReport] = useState<Record<string, unknown> | null>(null); const [hash, setHash] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [confirmed, setConfirmed] = useState(false);
  // Transient component state only: source bytes are never retained in runtime drafts/storage.
  const [prepared, setPrepared] = useState<{ unit: ImportUnit; key: string; attempted: boolean } | null>(null);
  const select = async (file: File | undefined) => {
    const attempt = ++selection.current;
    setReport(null); setHash(''); setError(''); setPrepared(null); setConfirmed(false); if (!file) return;
    const identity = runtime.auth.getSnapshot(); const period = runtime.getAccessPeriod();
    const current = () => selection.current === attempt && runtime.auth.getSnapshot().status === 'authenticated' && runtime.auth.getSnapshot().generation === identity.generation && runtime.getAccessPeriod() === period;
    setBusy(true);
    try {
      if (file.size > TRANSFER_LIMIT - 100) throw new ApiError(413);
      const bytes = new Uint8Array(await file.arrayBuffer()); if (!current()) return;
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!current()) return;
      let result: Record<string, unknown>;
      if (mode === 'csv') { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); result = await runtime.transfers.previewCsv(btoa(binary)); }
      else {
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (mode === 'restore') result = await runtime.transfers.previewRestore(data);
        else {
          if (!data || !['prepare', 'application', 'review', 'complete'].includes(data.unit) || !data.data || typeof data.data !== 'object' || Array.isArray(data.data) || Object.keys(data).some((key) => !['unit', 'data'].includes(key))) throw new ApiError(400);
          const unit = data as ImportUnit;
          if (unit.unit === 'prepare') {
            const sources = unit.data.sources as { name: string; bytesBase64: string }[] | undefined;
            const csv = sources?.filter((source) => /\.csv$/i.test(source.name));
            if (csv?.length !== 1 || typeof csv[0]?.bytesBase64 !== 'string') throw new ApiError(400);
            result = await runtime.transfers.previewCsv(csv[0].bytesBase64);
          } else { if (typeof unit.data.runId !== 'string') throw new ApiError(400); result = await runtime.transfers.previewRun(unit.data.runId); }
          if (current()) setPrepared({ unit, key: crypto.randomUUID(), attempted: false });
        }
      }
      if (current()) { setHash(digest); setReport(result); }
    } catch (error) { if (current()) setError(error instanceof ApiError && error.status === 413 ? 'Arquivo acima do limite web de 4 MB. Use o procedimento local documentado.' : 'Prévia recusada ou indisponível. Confira o formato, a integridade e a sessão. Nenhuma aplicação foi confirmada.'); }
    finally { if (current()) setBusy(false); }
  };
  const blocked = !!(report?.parsed as { blocked?: boolean } | undefined)?.blocked;
  const apply = async (retry = false) => {
    if (busy || (retry ? !transfer.pendingImport || transfer.pendingImport.unit.unit === 'csv' : !prepared || !confirmed || blocked)) return;
    const attempt = selection.current; const generation = runtime.auth.getSnapshot().generation; const period = runtime.getAccessPeriod();
    const current = () => attempt === selection.current && generation === runtime.auth.getSnapshot().generation && period === runtime.getAccessPeriod() && runtime.auth.getSnapshot().status === 'authenticated';
    setBusy(true); setError(''); if (!retry) setPrepared({ ...prepared!, attempted: true });
    try { const result = await (retry ? runtime.transfers.retryImport() : runtime.transfers.importUnit(prepared!.unit, prepared!.key)); if (current()) { setReport(result); setPrepared(null); } }
    catch { if (current()) setError('A aplicação não teve confirmação. Repita a mesma intenção para recuperar o resultado; não prepare uma nova unidade para contornar o erro.'); }
    finally { if (current()) setBusy(false); }
  };
  return <section className="review-panel"><h2>Conferir importação ou recuperação</h2><p>A fonte legada continua operacional até a conferência e o corte coordenado. Esta prévia não troca a fonte de verdade.</p><label>Tipo de conferência<select disabled={busy || !!prepared?.attempted || !!transfer.pendingImport} value={mode} onChange={(e) => { selection.current++; setMode(e.target.value as Mode); setReport(null); setPrepared(null); setHash(''); setError(''); }}><option value="csv">Prévia do CSV legado</option><option value="restore">Prévia estrutural do JSON de recuperação</option><option value="unit">Unidade de importação preparada</option></select></label><label>Arquivo privado<input key={mode} type="file" accept={mode === 'csv' ? '.csv' : '.json'} disabled={busy || !!prepared?.attempted || !!transfer.pendingImport} onChange={(e) => { void select(e.target.files?.[0]); e.target.value = ''; }} /></label>{busy && <p role="status">Conferindo transferência…</p>}{error && <p role="alert">{error}</p>}{hash && <p>SHA-256 do arquivo selecionado: {hash}</p>}{report && <><h3>Relatório validado pelo servidor</h3><pre className="review-report" tabIndex={0}>{JSON.stringify(report, null, 2)}</pre><p>{blocked ? 'Existem erros bloqueantes. Importação não autorizada.' : mode === 'restore' ? 'Estrutura conferida. O destino não foi verificado; restauração não aplicada.' : 'Confira IDs, lacunas, duplicatas, diferenças e erros antes de prosseguir.'}</p></>}
    {transfer.pendingImport?.unit.unit === 'csv' && <p className="review-notice">Há uma confirmação de CSV em andamento. <Link to="/vagas/importar">Voltar à importação em Vagas</Link></p>}
    {transfer.pendingImport && transfer.pendingImport.unit.unit !== 'csv' && <div className="review-notice"><h3>Importação aguardando confirmação</h3><p role="status">{transfer.importStatus === 'saving' ? 'Aguardando resposta do servidor para a unidade retida…' : 'O resultado permanece incerto. Repita exatamente a unidade já autorizada para recuperar a confirmação.'}</p><p>A unidade e sua chave ficam somente na memória desta aba, inclusive após navegar ou entrar novamente na mesma conta. Fechar ou recarregar a aba, sair da conta ou trocar de proprietário descarta esta recuperação. Mantenha a aba aberta até confirmar o resultado.</p><button disabled={busy || transfer.importStatus === 'saving'} onClick={() => { void apply(true); }}>Repetir mesma unidade retida</button></div>}
    {mode === 'unit' && <><p>Use somente uma unidade preparada e revisada conforme o protocolo privado: preparação, candidatura, revisão ou conclusão. A prévia compara a fonte ou execução existente; a validação completa da unidade ocorre na aplicação atômica.</p>{prepared && !transfer.pendingImport && <><p>Etapa selecionada: {{ prepare: 'Preparar execução', application: 'Importar candidatura', review: 'Importar revisão', complete: 'Concluir execução' }[prepared.unit.unit]}</p><label className="review-confirm"><input type="checkbox" checked={confirmed} disabled={busy || prepared.attempted} onChange={(e) => setConfirmed(e.target.checked)} />Conferi esta unidade e autorizo sua aplicação privada</label><button disabled={busy || !confirmed || blocked} onClick={() => { void apply(); }}>{prepared.attempted ? 'Repetir mesma unidade' : 'Aplicar unidade autorizada'}</button></>}</>}
    {transfer.importStatus === 'saved' && <p role="status">Última aplicação confirmada pelo servidor nesta aba. Uma nova seleção exige aplicação e confirmação próprias.</p>}
    <h3>Recuperação somente por manutenção local</h3><p>A interface não aplica restauração. O proprietário deve usar a prévia do script scripts/restore-private.ts, conferir o manifesto e um destino com todas as tabelas de negócio vazias, e só então aplicar pelo procedimento documentado em docs/private-transfers.md. Não exclua registros para preparar o destino. Credenciais de manutenção ficam no ambiente privado local, nunca neste formulário.</p>
  </section>;
}
