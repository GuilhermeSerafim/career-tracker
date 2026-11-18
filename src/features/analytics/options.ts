import type { AnalyticsQuery, AnalyticsResult, AnalyticsGroup, ReachedCategory } from '../../../shared/analytics';
import type { Metric } from '../../../shared/model';
import type { DisplayMetadata } from './metadata';

export type Explanation =
  | { kind: 'population'; name: keyof AnalyticsResult['populations'] }
  | { kind: 'conversion'; category: ReachedCategory }
  | { kind: 'completed' | 'eventsCategory'; category: ReachedCategory }
  | { kind: 'group'; collection: keyof AnalyticsResult['groups'] | 'selectedGrouping'; key: string; isMissing: boolean; category?: ReachedCategory }
  | { kind: 'series'; collection: 'daily' | 'weekly'; day: string }
  | { kind: 'eventsInPeriod' }
  | { kind: 'firstReturn'; selection: 'eligible' }
  | { kind: 'firstReturnDistribution'; days: number }
  | { kind: 'firstReturnExclusion'; reason: string }
  | { kind: 'coverage'; collection: 'precision' | 'certainty' | 'missing'; key: string };
export interface ChartRow { identity: string; label: string; actionLabel?: string; value: number; detail: string; explanation: Explanation; goal?: number; difference?: number; metrics?: { label: string; text: string; explanation: Explanation }[] }
export interface ChartModel { title: string; description: string; population: string; rows: ChartRow[]; temporal?: boolean }
export const categories: Record<ReachedCategory, string> = { response: 'Retorno substantivo', assessment: 'Avaliação', interview: 'Entrevista', offer: 'Oferta' };
export const metricText = (metric: Metric) => `${metric.numerator} / ${metric.denominator} · ${metric.ratio === null ? 'sem dados' : new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format(metric.ratio)}`;
export const selectionUrl = (query: AnalyticsQuery, explanation: Explanation) => `/vagas?${new URLSearchParams({ query: JSON.stringify(query), explain: JSON.stringify(explanation) })}`;
const populationText = (result: AnalyticsResult) => `${result.populations.conversionCohort.label} · denominador: ${result.populations.conversionCohort.count}`;
const groupRows = (groups: AnalyticsGroup[], collection: keyof AnalyticsResult['groups'] | 'selectedGrouping', denominator: number, referenceKind: 'resumes' | 'batches' | null, metadata?: DisplayMetadata): ChartRow[] => groups.map((group, index) => {
  const isReference = referenceKind !== null && !group.isMissing;
  const referenceText = referenceKind && metadata?.[referenceKind][group.key];
  const fallback = metadata ? referenceKind === 'resumes' ? 'Metadados de CV indisponíveis' : 'Metadados de lote indisponíveis' : 'Carregando metadados';
  const label = isReference ? `[${index + 1}] ${referenceText ?? fallback}` : group.label;
  return { identity: JSON.stringify([group.key, group.isMissing]), label, ...(isReference ? { actionLabel: `${label} · ID: ${group.key}` } : {}), value: group.count, detail: `${group.count} / ${denominator} na base de conversão${isReference ? ` · ID: ${group.key}` : ''}`, metrics: Object.entries(categories).map(([key, label]) => ({ label, text: metricText(group.conversions[key as ReachedCategory]), explanation: { kind: 'group', collection, key: group.key, isMissing: group.isMissing, category: key as ReachedCategory } })), explanation: { kind: 'group', collection, key: group.key, isMissing: group.isMissing } };
});
export function chartModels(result: AnalyticsResult, metadata?: DisplayMetadata): ChartModel[] {
  const cohort = populationText(result);
  const series = (collection: 'daily' | 'weekly', title: string): ChartModel => ({ title, description: 'Envios confirmados com dia exato no período. Barras: envios; linha tracejada com losangos: meta. A tabela inclui a diferença para a meta.', population: `${result.populations.submissionCohort.label} · denominador do período: ${result.populations.submissionCohort.count}`, temporal: true, rows: result[collection].map((point) => ({ identity: point.day, label: point.day.split('-').reverse().join('/'), value: point.count, goal: point.goal, difference: point.difference, detail: point.label, explanation: { kind: 'series', collection, day: point.day } })) });
  const groups = (collection: keyof AnalyticsResult['groups'] | 'selectedGrouping', title: string, description: string): ChartModel => ({ title, description, population: cohort, rows: groupRows(collection === 'selectedGrouping' ? result.selectedGrouping.groups : result.groups[collection], collection, result.populations.conversionCohort.count, collection === 'sentCv' ? 'resumes' : collection === 'selectedGrouping' && result.selectedGrouping.dimension === 'batch' ? 'batches' : null, metadata) });
  return [series('daily', 'Envios por dia'), series('weekly', 'Envios por semana'),
    { title: 'Categorias atingidas', description: 'Candidaturas únicas por categoria. Eventos repetidos contam uma vez; uma candidatura pode atingir várias categorias. Conclusão é informada separadamente.', population: cohort, rows: Object.entries(categories).map(([key, label]) => { const category = key as ReachedCategory; return { identity: key, label, value: result.conversions[category].numerator, detail: metricText(result.conversions[category]), explanation: { kind: 'conversion', category } }; }) },
    { title: 'Etapas concluídas', description: 'Candidaturas únicas com conclusão explicitamente registrada, dentro da base de conversão. Convites e agendamentos não implicam conclusão.', population: cohort, rows: Object.entries(categories).map(([key, label]) => { const category = key as ReachedCategory; return { identity: key, label, value: result.completed[category].count, detail: `${result.completed[category].count} / ${result.populations.conversionCohort.count}`, explanation: { kind: 'completed', category } }; }) },
    groups('discoveryChannel', 'Canal de descoberta', 'Canal informado pelo registro. Categorias ausentes permanecem distintas de textos literais iguais às suas chaves.'),
    groups('submissionPlatform', 'Plataforma de envio', 'Plataforma efetivamente informada para o envio.'),
    groups('stack', 'Stack informada', 'Grupos podem se sobrepor. Não some os grupos como candidaturas únicas.'),
    groups('sentCv', 'Currículo efetivamente enviado', 'Somente associações relatadas como CV enviado. Não informado é explícito. Grupos podem se sobrepor; não some os grupos como candidaturas únicas. Marcadores [1], [2] distinguem referências nesta seleção, sem indicar uma versão. IDs completos permanecem na tabela.'),
    groups('selectedGrouping', 'Evolução por lote', 'Resultados atuais das candidaturas de cada lote; não substituem revisões congeladas. Grupos podem se sobrepor. Marcadores entre colchetes distinguem referências nesta seleção. IDs completos e categoria sem lote permanecem na tabela.'),
    { title: 'Primeiro retorno substantivo', description: 'Dias corridos entre envio e primeiro retorno substantivo com datas exatas compatíveis. Ausência de resposta não vale zero. Distribuição: quantidade de candidaturas em cada intervalo.', population: `${cohort} · ${result.firstReturn.eligibleN} elegível(is)`, rows: result.firstReturn.distribution.map((point) => ({ identity: String(point.days), label: `${point.days} dia(s)`, value: point.applicationIds.length, detail: `${point.applicationIds.length} / ${result.firstReturn.eligibleN} casos elegíveis com envio e retorno compatíveis`, explanation: { kind: 'firstReturnDistribution', days: point.days } })) },
    { title: 'Acontecimentos no período', description: 'Não acrescentam novos envios. Usa a data do acontecimento, inclusive de candidaturas antigas. Categorias podem se sobrepor; não some os grupos como candidaturas únicas.', population: `Acontecimentos com data exata no período · ${result.eventsInPeriod.eventIds.length} evento(s) · denominador: ${result.eventsInPeriod.applicationIds.length} candidatura(s) única(s)`, rows: [{ identity: 'events', label: 'Candidaturas com acontecimentos', value: result.eventsInPeriod.applicationIds.length, detail: `${result.eventsInPeriod.applicationIds.length} / ${result.eventsInPeriod.applicationIds.length} candidaturas com acontecimentos, pela data de ocorrência`, explanation: { kind: 'eventsInPeriod' } }] },
    { title: 'Categorias de acontecimentos', description: 'Candidaturas com cada tipo de acontecimento ocorrido no período. Inclui processos anteriores, sem restringir à base de novos envios. Grupos podem se sobrepor.', population: `Base: ${result.eventsInPeriod.applicationIds.length} candidatura(s) com acontecimentos no período`, rows: Object.entries(categories).map(([key, label]) => { const category = key as ReachedCategory; return { identity: key, label, value: result.eventsInPeriod.categories[category].count, detail: `${result.eventsInPeriod.categories[category].count} / ${result.eventsInPeriod.applicationIds.length}`, explanation: { kind: 'eventsCategory', category } }; }) },
  ];
}
// ECharts is a type-only dependency here; runtime imports live in the lazy Chart module.
// eslint-disable-next-line no-restricted-imports
import type { EChartsCoreOption } from 'echarts/core';
export function chartOptions(model: ChartModel, reducedMotion: boolean): EChartsCoreOption {
  const labels = model.rows.map((row) => row.label);
  const windowed = model.rows.length > 10;
  return {
    animation: !reducedMotion, color: ['#0131CD', '#B9FC01'], textStyle: { fontFamily: 'Segoe UI, sans-serif', color: '#172033' },
    aria: { enabled: true, label: { enabled: true, description: `${model.title}. ${model.population}. ${model.description} Tabela equivalente e botões Ver candidaturas abaixo.` }, decal: { show: true } },
    legend: { data: model.temporal ? ['Envios', 'Meta (losango)'] : ['Candidaturas'], bottom: 0, textStyle: { color: '#172033' } },
    grid: { top: 28, right: windowed && !model.temporal ? 40 : 30, bottom: windowed && model.temporal ? 88 : 55, left: model.temporal ? 45 : 145, containLabel: false },
    xAxis: model.temporal ? { type: 'category', data: labels, axisLabel: { hideOverlap: true, color: '#526078' } } : { type: 'value', minInterval: 1 },
    yAxis: model.temporal ? { type: 'value', minInterval: 1 } : { type: 'category', inverse: true, data: labels, axisLabel: { width: 125, overflow: 'truncate', color: '#526078' } },
    ...(windowed ? { dataZoom: [{ type: 'slider', ...(model.temporal ? { xAxisIndex: 0, bottom: 30 } : { yAxisIndex: 0, right: 0, width: 16 }), startValue: 0, endValue: 9, filterMode: 'none' }] } : {}),
    series: [
      { name: model.temporal ? 'Envios' : 'Candidaturas', type: 'bar', barMaxWidth: 36, label: { show: true, position: model.temporal ? 'top' : 'right', color: '#172033' }, data: model.rows.map((row) => ({ id: row.identity, value: row.value })) },
      ...(model.temporal ? [{ name: 'Meta (losango)', type: 'line', symbol: 'diamond', symbolSize: 9, lineStyle: { type: 'dashed', color: '#526078', width: 2 }, itemStyle: { color: '#B9FC01', borderColor: '#172033', borderWidth: 1 }, data: model.rows.map((row) => row.goal) }] : []),
    ],
  };
}
