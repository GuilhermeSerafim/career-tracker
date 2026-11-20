import { Component, lazy, Suspense, useCallback, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { AppRuntime } from '../../app/runtime';
import type { AnalyticsQuery, AnalyticsResponse, AnalyticsResult } from '../../../shared/analytics';
import { analyticsQuerySchema, occurrenceDateBuckets } from '../../../shared/analytics';
import { ChartTable } from './ChartTable';
import { chartModels, selectionUrl } from './options';
import type { ChartModel, Explanation } from './options';
import { localDay } from '../today/today-data';
import './analytics.css';
import { readDisplayMetadata } from './metadata';
const Chart = lazy(() => import('./Chart'));
type QueryInput = Omit<AnalyticsQuery, 'asOf' | 'dailyGoal'>;
const inputSchema = analyticsQuerySchema.omit({ asOf: true, dailyGoal: true });
const coverageLabels = { precision: 'Precisão do envio', certainty: 'Certeza do envio', missing: 'Campos ausentes' };
const occurrenceLabels = { exactDay: 'Dia exato de ocorrência', imprecise: 'Data de ocorrência imprecisa', unknown: 'Data de ocorrência desconhecida' };
const analyticsUrl = (input: QueryInput) => `/api/v1/analytics?${new URLSearchParams({ query: JSON.stringify(input) })}`;
function restoredInput(raw: string | null): QueryInput | null {
  if (!raw) return null;
  try {
    const parsed = inputSchema.strip().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
class GraphicBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="status">Visualização indisponível. Use a tabela equivalente abaixo.</p> : this.props.children; }
}
export default function AnalyticsPage({ runtime }: { runtime: AppRuntime }) {
  const focusHeading = useCallback((heading: HTMLHeadingElement | null) => { heading?.focus(); }, []);
  const [params, setParams] = useSearchParams();
  const recalculation = useLocation().key;
  const [input, setInput] = useState<QueryInput>(() => {
    const restored = restoredInput(params.get('recalcular') ?? params.get('consulta'));
    if (restored) return restored;
    const today = localDay(new Date(), 'America/Sao_Paulo');
    const defaults: QueryInput = { operation: 'metrics', period: { from: `${today.slice(0, 7)}-01`, to: today }, population: 'confirmed', dimension: 'batch', submissionScope: 'submitted_in_period' };
    const parsed = inputSchema.safeParse({ ...defaults, period: { from: params.get('from') ?? defaults.period.from, to: params.get('to') ?? defaults.period.to }, population: params.get('population') ?? defaults.population, submissionScope: params.get('scope') ?? defaults.submissionScope });
    return parsed.success ? parsed.data : defaults;
  });
  const [draft, setDraft] = useState(input);
  const [invalid, setInvalid] = useState(false);
  const url = analyticsUrl(input);
  const queryKey = (path: string) => ['analytics', path, runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()];
  const data = useQuery({ queryKey: params.has('recalcular') ? [...queryKey(url), recalculation] : queryKey(url), queryFn: () => runtime.api.read<AnalyticsResponse>(url), refetchOnMount: false, refetchOnWindowFocus: false });
  return <><section className="page-intro"><p className="eyebrow">Perspectiva para avançar</p><h1 ref={focusHeading} tabIndex={-1}>Análises</h1><p className="intro-description">Cada número tem uma história. Abra os registros para entender o caminho.</p></section>
    <form className="analytics-filters" onSubmit={(event) => {
      event.preventDefault(); const bad = !inputSchema.safeParse(draft).success; setInvalid(bad);
      if (!bad) {
        setInput(draft); setParams({ from: draft.period.from, to: draft.period.to, population: draft.population, scope: draft.submissionScope,
          ...(draft.filters || draft.dimension !== 'batch' ? { consulta: JSON.stringify(draft) } : {}) }, { replace: true });
        const nextUrl = analyticsUrl(draft);
        // An intentional apply reads again even for a previously cached selection.
        void runtime.query.fetchQuery({ queryKey: queryKey(nextUrl), queryFn: () => runtime.api.read<AnalyticsResponse>(nextUrl), staleTime: 0 }).catch(() => undefined);
      }
    }}>
      <label>De<input type="date" required value={draft.period.from} onChange={(event) => setDraft({ ...draft, period: { ...draft.period, from: event.target.value } })} /></label>
      <label>Até<input type="date" required value={draft.period.to} onChange={(event) => setDraft({ ...draft, period: { ...draft.period, to: event.target.value } })} /></label>
      <label>População selecionada<select value={draft.population} onChange={(event) => setDraft({ ...draft, population: event.target.value as QueryInput['population'] })}><option value="confirmed">Envios confirmados</option><option value="saved">Oportunidades salvas</option><option value="unknown">Envio desconhecido</option><option value="all">Todos os estados de envio</option></select></label>
      <label>Base de conversão<select value={draft.submissionScope} onChange={(event) => setDraft({ ...draft, submissionScope: event.target.value as QueryInput['submissionScope'] })}><option value="submitted_in_period">Envios no período</option><option value="all_dates">Todas as datas de envio</option></select></label>
      <button type="submit">Aplicar período</button>{invalid && <p role="alert">Informe um período válido, com início anterior ou igual ao fim.</p>}
    </form>
    {data.isFetching && !data.isPending && <p role="status">Atualizando análises. Aguarde a nova resposta; o corte de conhecimento exibido ainda é o anterior.</p>}
    {data.isSuccess && <p className="analytics-context"><button disabled={data.isFetching} onClick={() => { void data.refetch(); }}>Atualizar análises</button> A análise exibida é preservada ao voltar dos registros. Atualize para consultar novas alterações.</p>}
    {data.isPending ? <p role="status">Carregando análises…</p> : data.isError ? <><p role="alert">Não foi possível carregar as análises. Seus dados não foram substituídos por zeros.</p><button onClick={() => { void data.refetch(); }}>Tentar novamente</button></> : <Analytics result={data.data} runtime={runtime} />}
  </>;
}
function Analytics({ result, runtime }: { result: AnalyticsResponse; runtime: AppRuntime }) {
  const navigate = useNavigate();
  const onSelect = useCallback((selection: Explanation) => navigate(selectionUrl(result.query, selection)), [navigate, result.query]);
  const references = useMemo(() => ({ resumes: result.groups.sentCv.filter((group) => !group.isMissing).map((group) => group.key), batches: result.selectedGrouping.dimension === 'batch' ? result.selectedGrouping.groups.filter((group) => !group.isMissing).map((group) => group.key) : [] }), [result]);
  const needsMetadata = references.resumes.length + references.batches.length > 0;
  const metadata = useQuery({ queryKey: ['analytics-display-metadata', references, runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()], queryFn: () => readDisplayMetadata(runtime, references.resumes, references.batches), enabled: needsMetadata, refetchOnMount: false, refetchOnWindowFocus: false });
  const models = useMemo(() => chartModels(result, metadata.data), [result, metadata.data]);
  const period = `${result.query.period.from.split('-').reverse().join('/')} a ${result.query.period.to.split('-').reverse().join('/')}`;
  return <div className="analytics-content"><p className="analytics-context">Período: <strong>{period}</strong> · Fuso: America/Sao_Paulo · Conhecimento até {result.asOf}. Registros arquivados elegíveis permanecem nos totais. As listas de análise consultam o estado atual; se houver alterações, atualize a análise.</p>
    {!result.populations.selected.count && <p className="application-notice">Sem dados nesta seleção. Registre sua primeira candidatura ou ajuste o período e a população.</p>}
    {needsMetadata && metadata.isFetching && <p role="status">Carregando rótulos de CVs e lotes. Contagens e IDs permanecem preservados.</p>}
    {needsMetadata && (metadata.isError || metadata.data?.unavailable) && <div role="alert"><p>Não foi possível carregar todos os rótulos de CVs e lotes. Os IDs continuam explícitos; os grupos conhecidos não foram tratados como ausentes.</p><button disabled={metadata.isFetching} onClick={() => { void metadata.refetch(); }}>Tentar novamente os rótulos</button></div>}
    <section className="analytics-totals" aria-label="Populações da análise">{Object.entries(result.populations).map(([name, population]) => <article key={name}><p>{population.label}</p><strong>{population.count}</strong><button onClick={() => onSelect({ kind: 'population', name: name as keyof AnalyticsResult['populations'] })}>Ver candidaturas<span className="sr-only">: {population.label}</span></button></article>)}</section>
    <section className="analytics-coverage" aria-label="Cobertura dos dados"><h2>Cobertura dos dados</h2><p>Base dos dados de envio e CV: {result.populations.allConfirmed.label} · {result.populations.allConfirmed.count} candidaturas.</p>
      {(['precision', 'certainty', 'missing'] as const).map((collection) => <div key={collection}><h3>{coverageLabels[collection]}</h3><div className="analytics-table-region" role="region" aria-label={`Cobertura: ${coverageLabels[collection]}`} tabIndex={0}><table><thead><tr><th scope="col">Cobertura</th><th scope="col">Numerador / denominador</th><th scope="col">Registros</th></tr></thead><tbody>{Object.entries(result.coverage[collection]).map(([key, population]) => <tr key={key}><th scope="row">{population.label}</th><td>{population.count} / {result.populations.allConfirmed.count}</td><td><button aria-label={`Ver candidaturas: ${population.label}`} onClick={() => onSelect({ kind: 'coverage', collection, key })}>Ver candidaturas</button></td></tr>)}</tbody></table></div></div>)}
      <OccurrenceDateCoverage coverage={result.occurrenceDateCoverage} drilldown={result.occurrenceDateDrilldown} onSelect={onSelect} />
    </section>
    <div className="analytics-grid">{models.map((model) => <ChartCard key={model.title} model={model} period={period} onSelect={onSelect}>
      {model.title === 'Envios por dia' && <p className="analytics-callout">{result.comparison.actual} envio(s) / meta {result.comparison.goal} · diferença: {result.comparison.difference}. Meta em todos os dias do período, inclusive fins de semana.</p>}
      {model.title === 'Primeiro retorno substantivo' && <><p className="analytics-callout">Mediana: <strong>{result.firstReturn.medianDays === null ? 'N/D · sem dados' : `${new Intl.NumberFormat('pt-BR').format(result.firstReturn.medianDays)} dia(s)`}</strong> · {result.firstReturn.eligibleN} elegível(is) / {result.populations.conversionCohort.count}</p><button onClick={() => onSelect({ kind: 'firstReturn', selection: 'eligible' })}>Ver candidaturas elegíveis</button><h3>Excluídos do cálculo</h3><div className="analytics-table-region" role="region" aria-label="Exclusões do primeiro retorno" tabIndex={0}><table><thead><tr><th scope="col">Motivo</th><th scope="col">Candidaturas</th><th scope="col">Registros</th></tr></thead><tbody>{Object.entries(result.firstReturn.exclusions).map(([reason, population]) => <tr key={reason}><th scope="row">{population.label}</th><td>{population.count}</td><td><button aria-label={`Ver candidaturas: ${population.label}`} onClick={() => onSelect({ kind: 'firstReturnExclusion', reason })}>Ver candidaturas</button></td></tr>)}</tbody></table></div></>}
    </ChartCard>)}</div></div>;
}
function OccurrenceDateCoverage({ coverage, drilldown, onSelect }: { coverage: AnalyticsResult['occurrenceDateCoverage']; drilldown: AnalyticsResponse['occurrenceDateDrilldown']; onSelect(selection: Explanation): void }) {
  const heading = useId();
  return <div>
    <h3 id={heading}>Data de ocorrência dos eventos</h3>
    <p>A base inclui os eventos vigentes das candidaturas selecionadas, em todas as datas. Somente eventos com dia exato entram nas séries do período. Cada lista abre as candidaturas únicas da categoria.</p>
    <div className="analytics-table-region" role="region" aria-labelledby={heading} tabIndex={0}>
      <table>
        <thead><tr><th scope="col">Data de ocorrência</th><th scope="col">Eventos da categoria / total de eventos</th><th scope="col">Candidaturas</th></tr></thead>
        <tbody>{occurrenceDateBuckets.map((bucket) => <tr key={bucket}>
          <th scope="row">{occurrenceLabels[bucket]}</th>
          <td>{coverage.buckets[bucket].eventCount} / {coverage.denominator} {coverage.denominator === 1 ? 'evento' : 'eventos'}</td>
          <td><button aria-label={`Ver candidaturas: ${occurrenceLabels[bucket]}`} onClick={() => onSelect({ kind: 'occurrenceDateCoverage', bucket, selectionKey: drilldown[bucket] })}>Ver candidaturas</button></td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}
function ChartCard({ model, period, onSelect, children }: { model: ChartModel; period: string; onSelect(selection: Explanation): void; children?: ReactNode }) {
  const id = useId();
  return <section className="analytics-card" aria-labelledby={id}><header><p className="eyebrow">{period}</p><h2 id={id}>{model.title}</h2></header><p>{model.description}</p><p className="analytics-population">{model.population}</p>{children}
    {model.rows.length > 0 && <GraphicBoundary><Suspense fallback={<p role="status">Carregando gráfico; a tabela já está disponível.</p>}><Chart model={model} onSelect={onSelect} /></Suspense></GraphicBoundary>}
    {model.rows.length > 10 && <p className="field-hint">O gráfico tem uma janela ajustável. A tabela contém todas as categorias.</p>}
    <ChartTable model={model} onSelect={onSelect} />
  </section>;
}
