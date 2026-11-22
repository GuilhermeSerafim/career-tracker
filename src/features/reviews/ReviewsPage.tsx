import { useQuery } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router';
import type { AppRuntime } from '../../app/runtime';
import type { TransferEntity } from '../../../shared/transfer';
import type { AnalyticsEvent, AnalyticsResult } from '../../../shared/analytics';
import type { DateValue } from '../../../shared/model';
import { DateField, type DateEditorState } from '../../components/DateField';
import { SafeLink } from '../../components/SafeLink';
import { createEditor } from './editor';
import { EditorActions } from './EditorActions';
import { evidence } from '../applications/application-data';
import { downloadText } from '../settings/transfer-client';
import './reviews.css';

export type Review = Extract<TransferEntity, { table: 'review_versions' }>['data'];
type Batch = Extract<TransferEntity, { table: 'batches' }>['data'];
export type BatchDetail = { batch: Batch; members: { applicationId: string; capturedOrder: number; eligible: boolean; allocation: string }[]; versions: { id: string; versionNumber: number; type: string; recordedAt: string }[]; preview: Review['snapshot']; rectificationPreview: Review['snapshot'] | null };
type ReviewRead = { version: Review; laterResults: (AnalyticsEvent & { canonicalApplicationId: string })[]; externalResults?: AnalyticsEvent[] };
const statusLabel = { open: 'Em andamento', pending: 'Revisão pendente', closed: 'Fechado' };
const typeLabel = { original: 'Original', revision: 'Nova análise', rectification: 'Retificação' };
const metricLabel: Record<string, string> = { substantive_return: 'Retorno substantivo', assessment: 'Avaliação', interview: 'Entrevista', offer: 'Proposta', rejection: 'Rejeição', response: 'Retorno', test: 'Avaliação' };
const stamp = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value)) : 'Data desconhecida';
async function readBatches(runtime: AppRuntime) {
  const items: Batch[] = []; let cursor: string | null = null; let state: string;
  do { const page: { state: string; items: Batch[]; nextCursor: string | null } = await runtime.api.read(`/api/v1/batches?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); items.push(...page.items); cursor = page.nextCursor; state = page.state; } while (cursor);
  return { state, items };
}
export function ReviewsPage({ runtime }: { runtime: AppRuntime }) {
  const { id } = useParams();
  const focus = useCallback((heading: HTMLHeadingElement | null) => heading?.focus(), []);
  const query = useQuery({ queryKey: ['reviews-area'], queryFn: () => readBatches(runtime) });
  return <div className="reviews-page"><section className="page-intro"><h1 ref={focus} tabIndex={-1}>Revisões</h1><p>Registre o que aprendeu e escolha os próximos passos.</p><Link to="/vagas/nova">Registrar candidatura ↗</Link><p>Uma revisão pendente não impede novos envios.</p></section>
    {query.isPending && <p role="status">Carregando lotes…</p>}{query.isError && <ReadError retry={() => { void query.refetch(); }} />}
    {query.data?.state === 'not_started' && <InitialCycle runtime={runtime} onSaved={() => { void query.refetch(); }} />}
    {query.data?.state === 'started' && <><nav className="review-batches" aria-label="Lotes">{query.data.items.map((batch) => <Link key={batch.id} to={`/revisoes/${batch.id}`} aria-current={id === batch.id ? 'page' : undefined}>Lote {batch.batchNumber} · {statusLabel[batch.status]}{batch.rectificationPending ? ' · Retificação pendente' : ''}</Link>)}</nav>{!query.data.items.length && <section className="review-panel"><h2>Seu ciclo está pronto</h2><p>As candidaturas elegíveis formarão lotes de 30. Nenhuma data de envio é presumida.</p></section>}</>}
    {id && <BatchView key={id} runtime={runtime} id={id} />}
  </div>;
}
function ReadError({ retry }: { retry(): void }) { return <><p role="alert">Não foi possível carregar os dados. Sua edição foi mantida.</p><button onClick={retry}>Tentar novamente</button></>; }
type Initial = { date: DateValue; dateEditor?: DateEditorState; marker: string };
const initialCompare = (f: Initial) => ({ 'Data inicial': JSON.stringify(f.date), 'Marco do ciclo': f.marker });
function InitialCycle({ runtime, onSaved }: { runtime: AppRuntime; onSaved(): void }) {
  const [editor] = useState(() => runtime.retainDraft('initial-cycle', () => createEditor<Initial, { state: string }>(runtime, {
    fields: { date: { precision: 'unknown', value: null }, marker: '' }, basis: { state: 'not_started' }, read: () => readBatches(runtime), fieldsFrom: () => ({ date: { precision: 'unknown', value: null }, marker: '' }), versions: () => ({}), compare: initialCompare,
    select: (local, current, selected) => ({ ...current, ...(selected.includes('Data inicial') ? { date: local.date, dateEditor: local.dateEditor } : {}), ...(selected.includes('Marco do ciclo') ? { marker: local.marker } : {}) }),
    command: (f, basis) => { if (basis.state !== 'not_started') throw new Error('Ciclo já iniciado'); return { operation: 'start_cycle', clientId: crypto.randomUUID(), resetDate: f.date, resetMarker: f.marker.trim() || null }; },
  })));
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot); const [valid, setValid] = useState(true);
  return <section className="review-panel"><h2>Iniciar seu primeiro ciclo</h2><p>Escolha explicitamente o marco. Se a data não for conhecida, mantenha “Desconhecida”.</p><fieldset disabled={!!state.intent}><legend>Marco inicial</legend><DateField label="Data inicial do ciclo" value={state.fields.date} editorState={state.fields.dateEditor} onChange={(date) => editor.edit({ date })} onEditorChange={(dateEditor) => editor.edit({ dateEditor })} onValidityChange={setValid} /><label>Marco do ciclo (opcional)<input value={state.fields.marker} onChange={(e) => editor.edit({ marker: e.target.value })} /></label></fieldset><EditorActions editor={editor} compare={initialCompare} button="Iniciar ciclo" valid={valid} onSaved={onSaved} /></section>;
}
function BatchView({ runtime, id }: { runtime: AppRuntime; id: string }) {
  const [selected, setSelected] = useState('');
  const detail = useQuery({ queryKey: ['review-batch', id], queryFn: () => runtime.api.read<BatchDetail>(`/api/v1/batches/${id}`) });
  const versionId = selected || detail.data?.versions.at(-1)?.id;
  const review = useQuery({ queryKey: ['review-version', versionId], enabled: !!versionId, queryFn: () => runtime.api.read<ReviewRead>(`/api/v1/reviews/${versionId}`) });
  const previousId = review.data?.version.predecessorId;
  const previous = useQuery({ queryKey: ['review-version', previousId], enabled: !!previousId && review.data?.version.type === 'rectification', queryFn: () => runtime.api.read<ReviewRead>(`/api/v1/reviews/${previousId}`) });
  const [downloadError, setDownloadError] = useState('');
  const refresh = () => { void detail.refetch(); void runtime.query.invalidateQueries({ queryKey: ['reviews-area'] }); if (versionId) void review.refetch(); };
  if (detail.isPending) return <p role="status">Carregando lote…</p>;
  if (detail.isError || !detail.data) return <ReadError retry={() => { void detail.refetch(); }} />;
  const d = detail.data; const v = review.data?.version;
  return <section className="review-panel" aria-label={`Lote ${d.batch.batchNumber}`}><h2>Lote {d.batch.batchNumber}</h2><p className="status-chip">{statusLabel[d.batch.status]}</p><button onClick={refresh}>Atualizar leitura do lote</button>
    {!!d.versions.length && <label>Versão selecionada<select value={versionId} onChange={(e) => setSelected(e.target.value)}>{d.versions.map((version) => <option key={version.id} value={version.id}>Versão {version.versionNumber} · {typeLabel[version.type as keyof typeof typeLabel]}</option>)}</select></label>}
    {versionId && review.isPending && <p role="status">Carregando versão…</p>}{review.isError && <ReadError retry={() => { void review.refetch(); }} />}
    {!versionId && <><p>Prévia não vinculante. O fechamento valida a versão do lote e congela o balanço.</p><Balance snapshot={d.preview} ids={d.members.map((m) => m.applicationId)} target={d.batch.target} /></>}
    {v && <><h3>Versão {v.versionNumber} · {typeLabel[v.type]}</h3><p>Fechamento: {stamp(v.closedAt)} · Versão registrada em {stamp(v.createdAt)}</p><p>Predecessora: {v.predecessorId || 'Nenhuma (original)'}</p>{v.reason && <p>Motivo: {v.reason}</p>}{v.type === 'rectification' && <p>Denominador retificado: {previous.data ? Object.values(previous.data.version.snapshot.metrics)[0]?.denominator : 'Releitura da predecessora pendente'} → {Object.values(v.snapshot.metrics)[0]?.denominator}. A versão anterior foi preservada.</p>}{previous.isError && <ReadError retry={() => { void previous.refetch(); }} />}<Balance snapshot={v.snapshot} ids={v.populationIds} target={d.batch.target} /><h3>Análise</h3><SafeMarkdown text={v.narrative || 'Sem análise informada.'} /><h3>Próximos passos</h3><ul>{v.decisions.map((decision, i) => <li key={i}><SafeMarkdown text={decision} /></li>)}</ul>
      <button onClick={() => { setDownloadError(''); const period = runtime.getAccessPeriod(); const generation = runtime.auth.getSnapshot().generation; void runtime.transfers.review(v.id).then((text) => { if (runtime.auth.getSnapshot().status !== 'authenticated' || runtime.auth.getSnapshot().generation !== generation || runtime.getAccessPeriod() !== period) return; downloadText(text, `revisao-v${v.versionNumber}.md`, 'text/markdown'); }).catch(() => setDownloadError('Não foi possível baixar a revisão. Tente novamente.')); }}>Baixar versão selecionada em Markdown</button>{downloadError && <p role="alert">{downloadError}</p>}
      <section aria-label="Resultados posteriores"><h3>Resultados posteriores</h3><p>Leitura atual; estes fatos não reescrevem a versão selecionada.</p>{review.data!.laterResults.length ? <ul>{review.data!.laterResults.map((event) => <li key={event.id}><Link to={`/vagas/${event.canonicalApplicationId}`}>{event.applicationId}</Link> · {event.kind} · {event.resultText || 'Sem descrição'} · Registrado em {stamp(event.recordedAt)}</li>)}</ul> : <p>Nenhum resultado posterior registrado.</p>}</section>
      <section aria-label="Resultados históricos externos"><h3>Resultados históricos externos</h3><p>Processos anteriores, fora do denominador desta versão.</p><ul>{(v.snapshot.externalResultApplicationIds ?? []).map((external) => <li key={external}><Link to={`/vagas/${external}`}>{external}</Link></li>)}</ul><ul>{review.data!.externalResults?.map((event) => <li key={event.id}>{event.kind} · {event.resultText || 'Sem descrição'} · {event.applicationId}</li>)}</ul><p>Eventos capturados: {(v.snapshot.externalResultEventIds ?? []).join(', ') || 'Nenhum informado'}</p></section>
    </>}
    {(d.batch.status === 'pending' || v) && <ReviewEditor runtime={runtime} detail={d} review={v} onSaved={refresh} />}
    {v && v.id !== d.versions.at(-1)?.id && <p>Esta versão anterior permanece preservada. Selecione a mais recente para criar uma nova versão.</p>}
  </section>;
}
export function Balance({ snapshot, ids, target, label = 'Balanço da versão' }: { snapshot: Review['snapshot']; ids: string[]; target: number; label?: string }) {
  const coverage = snapshot.coverage as AnalyticsResult['coverage'] | undefined;
  const denominator = snapshot.eligiblePopulationIds?.length ?? Object.values(snapshot.metrics)[0]?.denominator;
  return <><h3>Resultados na data da revisão</h3><p><strong>{denominator ?? 'Não informado'} elegíveis de {target}</strong> · {ids.length} IDs capturados</p><p>As taxas abaixo usam apenas as candidaturas elegíveis desta revisão.</p><div className="review-table" role="region" aria-label={label} tabIndex={0}><table><thead><tr><th>Resultado</th><th>Quantidade / elegíveis</th><th>Conversão</th></tr></thead><tbody>{Object.entries(snapshot.metrics).map(([name, metric]) => <tr key={name}><th>{metricLabel[name] || name}</th><td>{metric.numerator} / {metric.denominator}</td><td>{metric.ratio === null ? 'Sem dados' : `${(metric.ratio * 100).toFixed(1)}%`}</td></tr>)}</tbody></table></div><h3>Candidaturas desta revisão</h3><ol className="review-population">{ids.map((id) => <li key={id}><Link to={`/vagas/${id}`}>{snapshot.applications?.find((a) => a.id === id)?.displayId || id}</Link><span>{id}</span><span>{snapshot.eligiblePopulationIds ? snapshot.eligiblePopulationIds.includes(id) ? 'Elegível nesta versão' : 'Excluído nesta versão' : 'Elegibilidade individual não informada'}</span></li>)}</ol><h3>Dados que faltam</h3>{coverage?.missing ? <ul>{Object.values(coverage.missing).map((missing) => <li key={missing.label}>{missing.label}: {missing.applicationIds.length}<details><summary>Ver IDs afetados</summary>{missing.applicationIds.join(', ') || 'Nenhum'}</details></li>)}</ul> : <p>Cobertura não informada nesta versão histórica.</p>}</>;
}
type ReviewFields = { narrative: string; decisions: string; reason: string; proof: string; type: 'revision' | 'rectification' };
type Basis = { detail: BatchDetail; review?: Review };
const from = (b: Basis): ReviewFields => ({ narrative: b.review?.narrative ?? '', decisions: b.review?.decisions.join('\n') ?? '', reason: '', proof: '', type: 'revision' });
const labels = { narrative: 'Análise', decisions: 'Próximos passos', reason: 'Motivo', proof: 'Relato ou evidência', type: 'Tipo da nova versão' };
const compare = (f: ReviewFields) => Object.fromEntries(Object.entries(labels).map(([key, label]) => [label, f[key as keyof ReviewFields]]));
function ReviewEditor({ runtime, detail, review, onSaved }: { runtime: AppRuntime; detail: BatchDetail; review?: Review; onSaved(): void }) {
  const [editor] = useState(() => runtime.retainDraft(`review-edit:${detail.batch.id}`, () => createEditor(runtime, {
    fields: from({ detail, review }), basis: { detail, review } as Basis, fieldsFrom: from, compare, versions: (b) => ({ [b.detail.batch.id]: b.detail.batch.version }),
    read: async () => { const current = await runtime.api.read<BatchDetail>(`/api/v1/batches/${detail.batch.id}`); const last = current.versions.at(-1); return { detail: current, review: last ? (await runtime.api.read<ReviewRead>(`/api/v1/reviews/${last.id}`)).version : undefined }; },
    select: (local, current, selected) => ({ ...current, ...Object.fromEntries(Object.entries(labels).filter(([, label]) => selected.includes(label)).map(([key]) => [key, local[key as keyof ReviewFields]])) }),
    newDraftAfterConflict: (previous, current) => !previous.review && previous.detail.batch.status === 'pending' && current.detail.batch.status === 'closed' && !!current.review && current.detail.versions.at(-1)?.id === current.review.id && current.detail.batch.version > previous.detail.batch.version,
    command: (f, b) => { const common = { batch: { id: b.detail.batch.id, expectedVersion: b.detail.batch.version }, narrative: f.narrative || null, decisions: f.decisions.split('\n').filter(Boolean) }; return b.review ? { operation: 'revise_review', ...common, predecessorId: b.review.id, type: f.type, reason: f.reason, evidence: evidence(f.proof) } : { operation: 'close_review', ...common }; },
  })));
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot); const f = state.fields; const [checked, setChecked] = useState(false);
  const original = state.basis.review; const preview = state.basis.detail.rectificationPreview;
  const draftSnapshot = original ? f.type === 'rectification' ? preview : original.snapshot : state.basis.detail.preview;
  const draftIds = original?.populationIds ?? state.basis.detail.members.map((member) => member.applicationId);
  return <section className="review-editor" aria-label="Editar revisão"><h3>{original ? 'Criar nova versão privada' : 'Fechar e revisar lote'}</h3><p>Rascunho independente: {original ? `baseado na versão ${original.versionNumber}` : 'fechamento inicial'}, versão do lote {state.basis.detail.batch.version}. Atualizar a leitura ou selecionar outra versão não substitui este rascunho.</p><p>{original ? 'A versão original será preservada. Análise mantém o balanço; retificação reavalia a elegibilidade no conjunto capturado.' : 'Confira todos os IDs e as lacunas acima antes de fechar.'}</p>
    <fieldset disabled={!!state.intent}><legend>{original ? 'Nova versão' : 'Análise do lote'}</legend>{original && <label>Tipo da nova versão<select value={f.type} onChange={(e) => { setChecked(false); editor.edit({ type: e.target.value as ReviewFields['type'] }); }}><option value="revision">Nova análise (mesmo balanço)</option><option value="rectification">Retificação explícita</option></select></label>}{(['narrative', 'decisions', ...(original ? ['reason', 'proof'] : [])] as (keyof ReviewFields)[]).map((key) => <label key={key}>{labels[key]}<textarea value={f[key]} onChange={(e) => editor.edit({ [key]: e.target.value })} /></label>)}<p>Informe um próximo passo por linha.</p></fieldset>
    {f.type === 'rectification' && original && preview && <div className="review-notice"><h4>Alteração explícita do denominador</h4><p>{original.snapshot.eligiblePopulationIds?.length ?? Object.values(original.snapshot.metrics)[0]?.denominator} → {preview.eligiblePopulationIds?.length} elegíveis. Motivo: {f.reason || 'Informe o motivo.'}</p><p>Prévia não vinculante. A versão anterior e os IDs capturados permanecem preservados.</p></div>}
    <section className="review-notice" aria-label="Base para confirmar este rascunho"><h4>Base para confirmar este rascunho</h4><p>Lote na versão {state.basis.detail.batch.version}{original ? ` · revisão predecessora ${original.versionNumber}` : ' · fechamento inicial'}. Esta base pertence ao rascunho e independe da versão selecionada acima.</p><p>{original && f.type === 'revision' ? 'Balanço congelado da predecessora, preservado pela nova análise.' : 'Prévia não vinculante desta base. O salvamento valida a versão e calcula o balanço definitivo.'}</p>{draftSnapshot ? <Balance snapshot={draftSnapshot} ids={draftIds} target={state.basis.detail.batch.target} label="Balanço do rascunho" /> : <p role="alert">Balanço do rascunho indisponível. Releia a versão atual antes de confirmar.</p>}</section>
    <label className="review-confirm"><input type="checkbox" checked={checked} disabled={!draftSnapshot} onChange={(e) => setChecked(e.target.checked)} />Conferi a população, o balanço e as lacunas</label>
    <EditorActions editor={editor} compare={compare} button={original ? 'Salvar nova versão privada' : 'Confirmar fechamento'} valid={!!draftSnapshot && checked && (!original || !!f.reason.trim() && !!f.proof.trim())} onSaved={onSaved} onReapplied={() => setChecked(false)} />
    {state.intent?.getSnapshot().status === 'saved' && <button onClick={() => { setChecked(false); void editor.restart(); }}>Preparar nova revisão</button>}
  </section>;
}
/** A deliberately small Markdown subset: paragraph breaks and safe links; raw HTML is text. */
function SafeMarkdown({ text }: { text: string }) {
  return <div className="preserved-text">{text.split(/(\[[^\]\n]+\]\([^\s)]+\))/g).map((part, i) => { const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part); return link ? <SafeLink key={i} value={link[2]!} label={link[1]!} /> : <span key={i}>{part}</span>; })}</div>;
}
