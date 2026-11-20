import { useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { AppRuntime } from '../../app/runtime';
import { Filters } from './Filters';
import type { FilterState } from './Filters';
import { createFormDraft, stages, statuses } from './application-data';
import type { Application, ApplicationPage } from './application-data';
import { displayDate } from '../today/today-data';
import type { Stage } from '../../../shared/model';
import { ConflictDialog } from '../../components/ConflictDialog';
import { ApiError } from '../../lib/api';
import './applications.css';

function isOccurrenceSelection(raw: string | null): boolean {
  try { return JSON.parse(raw ?? 'null')?.kind === 'occurrenceDateCoverage'; }
  catch { return false; }
}

export function ListPage({ runtime }: { runtime: AppRuntime }) {
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<FilterState>({ view: 'confirmed', search: '', filters: {} });
  const [board, setBoard] = useState(false);
  const drilldown = params.has('ids') || params.has('query');
  const query = new URLSearchParams({ limit: '20', ...(drilldown ? { view: 'all' } : { view: filters.view, search: filters.search, filters: JSON.stringify(filters.filters) }) });
  if (drilldown) for (const key of ['ids', 'query', 'explain']) { const value = params.get(key); if (value) query.set(key, value); }
  const population = query.toString();
  const [pagination, setPagination] = useState<{ population: string; cursor: string | null; previous: (string | null)[] }>({ population, cursor: null, previous: [] });
  // Reset before constructing the request: an effect would send the old scope's cursor first.
  const { cursor, previous } = pagination.population === population ? pagination : { cursor: null, previous: [] };
  if (pagination.population !== population) setPagination({ population, cursor, previous });
  if (cursor) query.set('cursor', cursor);
  const url = `/api/v1/applications?${query}`;
  const data = useQuery({ queryKey: ['applications', url, runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()], queryFn: () => runtime.api.read<ApplicationPage>(url) });
  const checkingOccurrence = isOccurrenceSelection(params.get('explain')) && data.isFetching;
  const staleOccurrence = data.error instanceof ApiError && data.error.code === 'ANALYTICS_SELECTION_STALE';
  const analyticsQuery = params.get('query');
  const recalculation = analyticsQuery ? `/analises?${new URLSearchParams({ recalcular: analyticsQuery })}` : '/analises';
  return <><section className="page-intro application-heading"><div><p className="eyebrow">Sua busca, organizada</p><h1 tabIndex={-1}>Vagas</h1><p>Envios, oportunidades e o próximo passo.</p></div><Link className="application-primary" to="/vagas/nova">Registrar candidatura ↗</Link></section>
    {drilldown ? <p className="application-notice">Seleção da análise: população preservada, incluindo registros arquivados. <Link to="/vagas">Abrir lista geral</Link></p> : <Filters value={filters} onApply={(value) => { setFilters(value); setPagination({ population, cursor: null, previous: [] }); }} />}
    <div className="application-toolbar"><div aria-label="Formato da lista"><button aria-pressed={!board} onClick={() => setBoard(false)}>Tabela</button><button aria-pressed={board} onClick={() => setBoard(true)}>Quadro</button></div>{data.isSuccess && !checkingOccurrence && <p role="status">{data.data.total} registro(s) no filtro · {data.data.items.length} nesta página</p>}</div>
    {data.isPending || checkingOccurrence ? <p role="status">Carregando candidaturas…</p> : staleOccurrence ? <><p role="alert">A lista mudou desde o cálculo desta análise.</p><Link className="text-action" to={recalculation}>Recalcular análise</Link></> : data.isError ? <><p role="alert">Não foi possível carregar as candidaturas.</p><button onClick={() => { void data.refetch(); }}>Tentar novamente</button></> : <>
      {!data.data.items.length ? <p>Nenhum registro neste filtro. Ajuste os filtros ou registre uma candidatura.</p> : board ? <section className="application-board" aria-label="Quadro por etapa">{Object.entries(stages).map(([stage, label]) => <section key={stage} className="board-column"><h2>{label} <small>{data.data.items.filter((a) => a.stage === stage).length}</small></h2>{data.data.items.filter((a) => a.stage === stage).map((a) => <article key={`${a.id}:${a.version}`} className="application-card"><Card application={a} /><StageMove runtime={runtime} application={a} /></article>)}</section>)}</section> : <>
        <div className="application-table-region" role="region" aria-label="Tabela de candidaturas" tabIndex={0}><table><caption>Candidaturas</caption><thead><tr><th>Oportunidade</th><th>Trilha / tipo</th><th>Envio</th><th>Etapa</th><th>Canal / plataforma</th></tr></thead><tbody>{data.data.items.map((a) => <tr key={a.id}><td><Link to={`/vagas/${a.id}`}>{a.displayId} · {a.opportunity.company ?? 'Empresa não informada'}</Link><p>{a.opportunity.title ?? 'Cargo não informado'}</p>{a.archivedAt && <strong>Arquivada</strong>}</td><td>{a.track ?? 'Trilha não informada'}<p>{kindLabel(a)}</p></td><td>{statuses[a.submissionStatus]}<p>{displayDate(a.submittedDate, 'America/Sao_Paulo')}</p></td><td>{stages[a.stage]}</td><td>{a.discoveryChannel ?? 'Canal não informado'}<p>{a.submissionPlatform ?? 'Plataforma não informada'}</p></td></tr>)}</tbody></table></div>
        <div className="application-mobile-cards">{data.data.items.map((a) => <article className="application-card" key={a.id}><Card application={a} /></article>)}</div>
      </>}
      <nav className="application-pagination" aria-label="Páginas de candidaturas"><button disabled={!previous.length} onClick={() => setPagination({ population, cursor: previous.at(-1)!, previous: previous.slice(0, -1) })}>Página anterior</button><span>Página {previous.length + 1}</span><button disabled={!data.data.nextCursor} onClick={() => setPagination({ population, cursor: data.data.nextCursor, previous: [...previous, cursor] })}>Próxima página</button></nav>
    </>}
  </>;
}
const kindLabel = (a: Application) => ({ vaga: 'Vaga', banco_talentos: 'Banco de talentos', pipeline: 'Pipeline', desconhecido: 'Tipo desconhecido' }[a.opportunity.kind]);
function Card({ application: a }: { application: Application }) { return <><p className="eyebrow">{a.displayId} {a.archivedAt ? '· Arquivada' : ''}</p><h3><Link to={`/vagas/${a.id}`}>{a.opportunity.company ?? 'Empresa não informada'} · {a.opportunity.title ?? 'Cargo não informado'}</Link></h3><p>{a.track ?? 'Trilha não informada'} · {kindLabel(a)}</p><p>{statuses[a.submissionStatus]} · {displayDate(a.submittedDate, 'America/Sao_Paulo')}</p><p>{stages[a.stage]}</p></>; }
function StageMove({ runtime, application: a }: { runtime: AppRuntime; application: Application }) {
  const [draft] = useState(() => runtime.retainDraft(`board:${a.id}`, () => createFormDraft(runtime, { application: a, links: [], resumeRefs: [], tasks: [], events: [], contacts: [], evidence: [], affectedBatches: [] })));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const save = state.intent?.getSnapshot();
  const [conflictOpen, setConflictOpen] = useState(true);
  return <><label>Etapa de {a.displayId}<select aria-label={`Etapa de ${a.displayId}`} value={state.fields.stage} disabled={!!save} onChange={(e) => draft.patch({ stage: e.target.value as Stage })}>{Object.entries(stages).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button disabled={!!save || state.fields.stage === a.stage} onClick={() => { void draft.begin({ operation: 'update_application', application: { id: a.id, expectedVersion: a.version }, changes: { stage: state.fields.stage }, affectedBatches: [] }); }}>Mover {a.displayId}</button>
    <p className="field-hint">Somente a etapa; não confirma envio ou conclusão.</p>
    {save?.status === 'saved' && <><p role="status">Etapa registrada.</p><button onClick={() => { runtime.abandonDraft(`board:${a.id}`); void runtime.query.invalidateQueries({ queryKey: ['applications'] }); }}>Atualizar quadro</button></>}
    {save?.error && <p role="alert">{save.error.message}</p>}
    {save && ['unavailable', 'error', 'editing'].includes(save.status) && <button onClick={() => { void state.intent!.save(); }}>Repetir movimento original</button>}
    {save?.status === 'refresh-required' && <button onClick={() => { void state.intent!.refresh(); }}>Reler acesso</button>}
    {save && ['conflict', 'refresh-required'].includes(save.status) && <><button onClick={() => setConflictOpen(true)}>Comparar etapa</button>{conflictOpen && <ConflictDialog local={{ Etapa: state.fields.stage }} current={save.current} onRefresh={() => state.intent!.refresh()} onReapply={(selected) => { draft.reapply(selected); setConflictOpen(false); }} onClose={() => setConflictOpen(false)} />}</>}
  </>;
}
