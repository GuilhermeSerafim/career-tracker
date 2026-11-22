import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { AppRuntime } from '../../app/runtime';
import { Filters } from './Filters';
import type { FilterState } from './Filters';
import { stages, statuses } from './application-data';
import type { Application, ApplicationPage } from './application-data';
import { displayDate } from '../today/today-data';
import { ApiError } from '../../lib/api';
import { ApplicationBoard } from './ApplicationBoard';
import './applications.css';

function isOccurrenceSelection(raw: string | null): boolean {
  try { return JSON.parse(raw ?? 'null')?.kind === 'occurrenceDateCoverage'; }
  catch { return false; }
}

async function readBoard(runtime: AppRuntime, scope: URLSearchParams, signal: AbortSignal): Promise<ApplicationPage> {
  const params = new URLSearchParams(scope);
  const items = new Map<string, Application>();
  const cursors = new Set<string>();
  let page: ApplicationPage;
  do {
    signal.throwIfAborted();
    page = await runtime.api.read<ApplicationPage>(`/api/v1/applications?${params}`);
    for (const item of page.items) items.set(item.id, item);
    if (page.nextCursor) {
      if (cursors.has(page.nextCursor)) throw new ApiError(503);
      cursors.add(page.nextCursor);
      params.set('cursor', page.nextCursor);
    }
  } while (page.nextCursor);
  return { items: [...items.values()], total: page.total, nextCursor: null };
}

export function ListPage({ runtime }: { runtime: AppRuntime }) {
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<FilterState>({ view: 'confirmed', search: '', filters: {} });
  const [boardView, setBoardView] = useState('all');
  const [board, setBoard] = useState(false);
  const drilldown = params.has('ids') || params.has('query');
  const currentFilters = board ? { ...filters, view: boardView } : filters;
  const query = new URLSearchParams({ limit: board ? '100' : '20', ...(drilldown ? { view: 'all' } : { view: currentFilters.view, search: currentFilters.search, filters: JSON.stringify(currentFilters.filters) }) });
  if (drilldown) for (const key of ['ids', 'query', 'explain']) { const value = params.get(key); if (value) query.set(key, value); }
  const population = query.toString();
  const tableScope = new URLSearchParams(query);
  tableScope.set('limit', '20');
  if (!drilldown) tableScope.set('view', filters.view);
  const tablePopulation = tableScope.toString();
  const [pagination, setPagination] = useState<{ population: string; cursor: string | null; previous: (string | null)[] }>({ population: tablePopulation, cursor: null, previous: [] });
  // Reset before constructing the request: an effect would send the old scope's cursor first.
  const { cursor, previous } = pagination.population === tablePopulation ? pagination : { cursor: null, previous: [] };
  if (pagination.population !== tablePopulation) setPagination({ population: tablePopulation, cursor, previous });
  if (!board && cursor) query.set('cursor', cursor);
  const url = `/api/v1/applications?${query}`;
  const data = useQuery({ queryKey: ['applications', board ? 'board' : 'table', url, runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()],
    queryFn: ({ signal }) => board ? readBoard(runtime, query, signal) : runtime.api.read<ApplicationPage>(url) });
  const checkingOccurrence = isOccurrenceSelection(params.get('explain')) && data.isFetching;
  const staleOccurrence = data.error instanceof ApiError && data.error.code === 'ANALYTICS_SELECTION_STALE';
  const analyticsQuery = params.get('query');
  const recalculation = analyticsQuery ? `/analises?${new URLSearchParams({ recalcular: analyticsQuery })}` : '/analises';
  return <><section className="page-intro application-heading"><div><h1 tabIndex={-1}>Vagas</h1><p>Organize suas oportunidades e acompanhe a etapa de cada processo.</p></div><div className="application-heading-actions"><Link className="text-action" to="/vagas/importar">Importar CSV</Link><Link className="application-primary" to="/vagas/nova">Registrar candidatura</Link></div></section>
    <div className="application-toolbar"><div role="group" aria-label="Formato da lista"><button aria-pressed={!board} onClick={() => setBoard(false)}>Tabela</button><button aria-pressed={board} onClick={() => setBoard(true)}>Quadro</button></div>{data.isSuccess && !checkingOccurrence && <p role="status">{board ? `${data.data.items.length} ${data.data.items.length === 1 ? 'registro no quadro' : 'registros no quadro'}` : `${data.data.total} registro(s) no filtro · ${data.data.items.length} nesta página`}</p>}</div>
    {drilldown ? <p className="application-notice">Registros desta análise, incluindo arquivados. <Link to="/vagas">Abrir lista geral</Link></p> : <Filters key={board ? 'board' : 'table'} value={currentFilters} onApply={(value) => {
      if (board) setBoardView(value.view);
      setFilters({ ...value, view: board ? filters.view : value.view });
      setPagination({ population: tablePopulation, cursor: null, previous: [] });
    }} />}
    {data.isPending || checkingOccurrence ? <p role="status">Carregando candidaturas…</p> : staleOccurrence ? <><p role="alert">A lista mudou desde o cálculo desta análise.</p><Link className="text-action" to={recalculation}>Recalcular análise</Link></> : data.isError ? <><p role="alert">Não foi possível carregar as candidaturas.</p><button onClick={() => { void data.refetch(); }}>Tentar novamente</button></> : <>
      {!data.data.items.length ? <p>Nenhum registro neste filtro. Ajuste os filtros ou registre uma candidatura.</p> : board ? <ApplicationBoard key={population} runtime={runtime} items={data.data.items} /> : <>
        <div className="application-table-region" role="region" aria-label="Tabela de candidaturas" tabIndex={0}><table><caption>Candidaturas</caption><thead><tr><th>Oportunidade</th><th>Trilha / tipo</th><th>Situação do envio</th><th>Última etapa registrada</th><th>Canal / plataforma</th></tr></thead><tbody>{data.data.items.map((a) => <tr key={a.id}><td><Link to={`/vagas/${a.id}`}>{a.displayId} · {a.opportunity.company ?? 'Empresa não informada'}</Link><p>{a.opportunity.title ?? 'Cargo não informado'}</p>{a.archivedAt && <strong>Arquivada</strong>}</td><td>{a.track ?? 'Trilha não informada'}<p>{kindLabel(a)}</p></td><td>{statuses[a.submissionStatus]}<p>{displayDate(a.submittedDate, 'America/Sao_Paulo')}</p></td><td>{stages[a.stage]}</td><td>{a.discoveryChannel ?? 'Canal não informado'}<p>{a.submissionPlatform ?? 'Plataforma não informada'}</p></td></tr>)}</tbody></table></div>
        <div className="application-mobile-cards">{data.data.items.map((a) => <article className="application-card" key={a.id}><Card application={a} /></article>)}</div>
      </>}
      {!board && <nav className="application-pagination" aria-label="Páginas de candidaturas"><button disabled={!previous.length} onClick={() => setPagination({ population: tablePopulation, cursor: previous.at(-1)!, previous: previous.slice(0, -1) })}>Página anterior</button><span>Página {previous.length + 1}</span><button disabled={!data.data.nextCursor} onClick={() => setPagination({ population: tablePopulation, cursor: data.data.nextCursor, previous: [...previous, cursor] })}>Próxima página</button></nav>}
    </>}
  </>;
}
const kindLabel = (a: Application) => ({ vaga: 'Vaga', banco_talentos: 'Banco de talentos', pipeline: 'Pipeline', desconhecido: 'Tipo desconhecido' }[a.opportunity.kind]);
function Card({ application: a }: { application: Application }) { return <><p className="eyebrow">{a.displayId} {a.archivedAt ? '· Arquivada' : ''}</p><h3><Link to={`/vagas/${a.id}`}>{a.opportunity.company ?? 'Empresa não informada'} · {a.opportunity.title ?? 'Cargo não informado'}</Link></h3><p>{a.track ?? 'Trilha não informada'} · {kindLabel(a)}</p><p>{statuses[a.submissionStatus]} · {displayDate(a.submittedDate, 'America/Sao_Paulo')}</p><p>{stages[a.stage]}</p></>; }
