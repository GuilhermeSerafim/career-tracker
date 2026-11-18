import { type ApplicationMetricsRow, type Metric } from '../shared/model.js';
import { MAX_ANALYTICS_DAYS, MAX_ANALYTICS_ENTRIES, analyticsEventSchema, analyticsQuerySchema, analyticsRowSchema, type AnalyticsEvent, type AnalyticsGroup, type AnalyticsQuery, type AnalyticsResult, type AnalyticsRow, type Population, type ReachedCategory, type SeriesPoint } from '../shared/analytics.js';
import { addCivilDays, civilDaysBetween, instantNanoseconds, mondayOfWeek, toLocalDay } from './dates.js';

const categories: ReachedCategory[] = ['response', 'assessment', 'interview', 'offer'];
const labels: Record<string, string> = { unknown: 'Desconhecida', day: 'Dia', month: 'Mês', year: 'Ano', instant: 'Instante', exact: 'Exata', approximate: 'Aproximada', sem_cv_informado: 'Sem CV enviado informado', sem_stack_informada: 'Sem stack informada', canal_desconhecido: 'Canal desconhecido', plataforma_desconhecida: 'Plataforma desconhecida' };
const coverageLabel = (key: string): string => Object.hasOwn(labels, key) ? labels[key]! : key;
function unique<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.map((row) => ({ ...row, id: row.id.toLowerCase() })).filter((row) => !seen.has(row.id) && !!seen.add(row.id));
}
function confirmed<T extends ApplicationMetricsRow>(rows: T[]): T[] {
  return unique(rows).filter((row) => row.submissionStatus === 'confirmado' && row.countingEligible && row.canonicalApplicationId === null);
}
function population(label: string, ids: string[]): Population {
  const applicationIds = [...new Set(ids)].sort();
  return { label, applicationIds, count: applicationIds.length };
}
function rowPopulation(label: string, rows: ApplicationMetricsRow[]): Population { return population(label, rows.map((row) => row.id)); }
export function countDailySubmissions(rows: ApplicationMetricsRow[], day: string): number {
  return confirmed(rows).filter((row) => toLocalDay(row.submittedDate) === day).length;
}
export function conversion(rows: ApplicationMetricsRow[], reachedIds: ReadonlySet<string>): Metric {
  const cohort = confirmed(rows);
  const normalizedReached = new Set([...reachedIds].map((id) => id.toLowerCase()));
  const applicationIds = cohort.filter((row) => normalizedReached.has(row.id)).map((row) => row.id).sort();
  return { numerator: applicationIds.length, denominator: cohort.length, ratio: cohort.length === 0 ? null : applicationIds.length / cohort.length, applicationIds };
}
function category(event: AnalyticsEvent): ReachedCategory | null {
  return ({ retorno_substantivo: 'response', avaliacao: 'assessment', entrevista: 'interview', proposta: 'offer' } as Partial<Record<AnalyticsEvent['kind'], ReachedCategory>>)[event.kind] ?? null;
}
function matches(row: AnalyticsRow, query: AnalyticsQuery): boolean {
  const f = query.filters ?? {};
  const scalar = (values: string[] | undefined, value: string | null) => values === undefined || (value !== null && values.includes(value));
  const multi = (values: string[] | undefined, actual: string[]) => values === undefined || values.some((value) => actual.includes(value));
  return scalar(f.company, row.company) && scalar(f.title, row.title) && scalar(f.seniority, row.seniority) && scalar(f.modality, row.modality)
    && scalar(f.channel, row.discoveryChannel) && scalar(f.platform, row.submissionPlatform) && scalar(f.status, row.submissionStatus) && scalar(f.stage, row.stage)
    && multi(f.stack, row.stack) && multi(f.batch, row.batchIds)
    && (f.archived !== 'exclude' || row.archivedAt === null) && (f.archived !== 'only' || row.archivedAt !== null);
}
function groupCoverage(rows: AnalyticsRow[], key: (row: AnalyticsRow) => string): Record<string, Population> {
  const groups: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const row of rows) (groups[key(row)] ??= []).push(row.id);
  return Object.fromEntries(Object.entries(groups).map(([name, ids]) => [name, population(coverageLabel(name), ids)]));
}
function firstReturn(rows: AnalyticsRow[], events: AnalyticsEvent[]): AnalyticsResult['firstReturn'] {
  const excluded: Record<string, string[]> = { imprecise_submission: [], uncertain_response: [], response_before_submission: [], no_recorded_response: [] };
  const distribution = new Map<number, string[]>();
  const responsesByApplication = new Map<string, AnalyticsEvent[]>();
  for (const event of events) if (event.kind === 'retorno_substantivo') {
    const responses = responsesByApplication.get(event.applicationId) ?? [];
    responses.push(event);
    responsesByApplication.set(event.applicationId, responses);
  }
  for (const row of rows) {
    const submission = toLocalDay(row.submittedDate);
    if (submission === null) { excluded.imprecise_submission!.push(row.id); continue; }
    const responses = responsesByApplication.get(row.id) ?? [];
    if (responses.length === 0) { excluded.no_recorded_response!.push(row.id); continue; }
    const exact = responses.map((event) => ({ event, day: toLocalDay(event.occurredDate) })).filter((item) => item.day !== null);
    const definitelyEarlierPeriod = responses.some(({ occurredDate: date }) => date.precision !== 'unknown' && date.certainty === 'exact' && ((date.precision === 'month' && date.value < submission.slice(0, 7)) || (date.precision === 'year' && date.value < submission.slice(0, 4))));
    const before = definitelyEarlierPeriod || exact.some(({ event, day }) => day! < submission || (row.submittedDate.precision === 'instant' && event.occurredDate.precision === 'instant' && instantNanoseconds(event.occurredDate.value) < instantNanoseconds(row.submittedDate.value)));
    if (before) { excluded.response_before_submission!.push(row.id); continue; }
    const earliest = exact.map((item) => item.day!).sort()[0];
    // A precise later month/year can establish that an uncertain response was not first.
    const ambiguous = responses.some(({ occurredDate: date }) => {
      if (toLocalDay(date) !== null) return false;
      if (!earliest || date.precision === 'unknown' || date.certainty === 'approximate') return true;
      const lower = date.precision === 'month' ? `${date.value}-01` : `${date.value}-01-01`;
      return lower <= earliest;
    });
    if (!earliest || ambiguous) { excluded.uncertain_response!.push(row.id); continue; }
    const days = civilDaysBetween(submission, earliest);
    const members = distribution.get(days) ?? [];
    members.push(row.id);
    distribution.set(days, members);
  }
  const points = [...distribution].sort(([a], [b]) => a - b).map(([days, ids]) => ({ days, applicationIds: ids.sort() }));
  const values = points.flatMap((point) => point.applicationIds.map(() => point.days));
  const middle = Math.floor(values.length / 2);
  const labels: Record<string, string> = { imprecise_submission: 'Envio sem dia exato', uncertain_response: 'Ordem do primeiro retorno indeterminável', response_before_submission: 'Retorno anterior ao envio: revisar dados', no_recorded_response: 'Sem retorno registrado; histórico desconhecido' };
  return { medianDays: values.length ? (values[middle]! + values[Math.floor((values.length - 1) / 2)]!) / 2 : null, eligibleN: values.length, applicationIds: points.flatMap((point) => point.applicationIds).sort(), distribution: points, exclusions: Object.fromEntries(Object.entries(excluded).map(([reason, ids]) => [reason, population(labels[reason]!, ids)])) };
}

export function buildAnalytics(inputRows: AnalyticsRow[], inputEvents: AnalyticsEvent[], inputQuery: AnalyticsQuery): AnalyticsResult {
  if (!Array.isArray(inputRows) || !Array.isArray(inputEvents) || inputRows.length > MAX_ANALYTICS_ENTRIES || inputEvents.length > MAX_ANALYTICS_ENTRIES) throw new RangeError('Informe no máximo 100000 aplicações e 100000 eventos, sem truncamento.');
  const query = analyticsQuerySchema.parse(inputQuery);
  const duration = civilDaysBetween(query.period.from, query.period.to);
  if (duration + 1 > MAX_ANALYTICS_DAYS) throw new RangeError('O período pode conter no máximo 3660 dias de calendário.');
  if (query.filters?.batch) query.filters.batch = query.filters.batch.map((id) => id.toLowerCase());
  const rows = unique(inputRows.map((input) => {
    const row = analyticsRowSchema.parse(input);
    return { ...row, canonicalApplicationId: row.canonicalApplicationId?.toLowerCase() ?? null, resumeIds: row.resumeIds.map((id) => id.toLowerCase()), batchIds: row.batchIds.map((id) => id.toLowerCase()) };
  }));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const canonicalIds = new Map<string, string>();
  const canonicalId = (id: string): string => {
    const cached = canonicalIds.get(id);
    if (cached) return cached;
    const visited = new Set<string>();
    let current = id;
    while (true) {
      const intermediateRoot = canonicalIds.get(current);
      if (intermediateRoot) { current = intermediateRoot; break; }
      if (visited.has(current)) throw new Error('Ciclo de redirecionamento canônico inválido.');
      visited.add(current);
      const row = rowsById.get(current);
      if (!row) throw new Error('Aplicação canônica ausente da projeção.');
      if (row.canonicalApplicationId === null) break;
      current = row.canonicalApplicationId;
    }
    for (const member of visited) canonicalIds.set(member, current);
    return current;
  };
  for (const row of rows) canonicalId(row.id);
  const cutoff = instantNanoseconds(query.asOf);
  const known = unique(inputEvents.map((input) => {
    const event = analyticsEventSchema.parse(input);
    return { ...event, applicationId: event.applicationId.toLowerCase(), supersedesEventId: event.supersedesEventId?.toLowerCase() ?? null };
  })).filter((event) => instantNanoseconds(event.recordedAt) <= cutoff);
  for (const event of known) canonicalId(event.applicationId);
  const knownById = new Map(known.map((event) => [event.id, event]));
  const superseded = new Set<string>();
  const validated = new Set<string>();
  for (const event of known) {
    const visited = new Set<string>();
    let current = event;
    while (!validated.has(current.id)) {
      if (visited.has(current.id)) throw new Error('Ciclo de correções inválido.');
      visited.add(current.id);
      if (current.supersedesEventId === null) break;
      const target = knownById.get(current.supersedesEventId);
      if (!target || canonicalId(target.applicationId) !== canonicalId(current.applicationId)) throw new Error('Correção sem evento original compatível no corte de conhecimento.');
      superseded.add(target.id);
      current = target;
    }
    for (const id of visited) validated.add(id);
  }
  const selected = rows.filter((row) => matches(row, query)).filter((row) => query.population === 'all' || (query.population === 'confirmed' ? row.submissionStatus === 'confirmado' : query.population === 'saved' ? row.submissionStatus === 'nao_enviado' : row.submissionStatus === 'nao_confirmado'));
  const allConfirmed = confirmed(selected);
  const inPeriod = (day: string | null) => day !== null && day >= query.period.from && day <= query.period.to;
  const submissionCohort = allConfirmed.filter((row) => inPeriod(toLocalDay(row.submittedDate)));
  const cohort = query.submissionScope === 'all_dates' ? allConfirmed : submissionCohort;
  const selectedIds = new Set(selected.map((row) => row.id));
  const events = known.filter((event) => !superseded.has(event.id)).map((event) => ({ ...event, applicationId: canonicalId(event.applicationId) })).filter((event) => selectedIds.has(event.applicationId));
  const categoryIds = (source: AnalyticsEvent[], name: ReachedCategory) => new Set(source.filter((event) => category(event) === name).map((event) => event.applicationId));
  const reached = new Map(categories.map((name) => [name, categoryIds(events, name)]));
  const conversionsFor = (group: AnalyticsRow[]) => Object.fromEntries(categories.map((name) => {
    const applicationIds = group.filter((row) => reached.get(name)!.has(row.id)).map((row) => row.id).sort();
    return [name, { numerator: applicationIds.length, denominator: group.length, ratio: group.length ? applicationIds.length / group.length : null, applicationIds }];
  })) as Record<ReachedCategory, Metric>;
  const completed = Object.fromEntries(categories.map((name) => {
    const ids = categoryIds(events.filter((event) => event.state === 'concluido'), name);
    return [name, rowPopulation('Concluídas', cohort.filter((row) => ids.has(row.id)))];
  })) as Record<ReachedCategory, Population>;
  const makeGroups = (keys: (row: AnalyticsRow) => string[], overlapping: boolean, missing?: { key: string; label: string }): AnalyticsGroup[] => {
    const buckets = new Map<string, { key: string; label: string; isMissing: boolean; members: AnalyticsRow[] }>();
    for (const row of cohort) {
      const values = keys(row);
      const entries = values.length ? [...new Set(values)].map((key) => ({ key, label: key, isMissing: false })) : missing ? [{ ...missing, isMissing: true }] : [];
      for (const entry of entries) {
        const identity = JSON.stringify([entry.key, entry.isMissing]);
        const bucket = buckets.get(identity) ?? { ...entry, members: [] };
        bucket.members.push(row);
        buckets.set(identity, bucket);
      }
    }
    return [...buckets.values()].sort((a, b) => a.isMissing && a.key === 'sem_cv_informado' ? -1 : b.isMissing && b.key === 'sem_cv_informado' ? 1 : a.key.localeCompare(b.key) || Number(a.isMissing) - Number(b.isMissing)).map(({ key, label, isMissing, members }) => ({ key, isMissing, ...rowPopulation(label, members), overlapping, conversions: conversionsFor(members) }));
  };
  const dimensionKeys: Record<AnalyticsQuery['dimension'], (row: AnalyticsRow) => string[]> = {
    company: (row) => row.company === null ? [] : [row.company], title: (row) => row.title === null ? [] : [row.title],
    stack: (row) => row.stack, seniority: (row) => row.seniority === null ? [] : [row.seniority],
    modality: (row) => row.modality === null ? [] : [row.modality], channel: (row) => row.discoveryChannel === null ? [] : [row.discoveryChannel],
    platform: (row) => row.submissionPlatform === null ? [] : [row.submissionPlatform], status: (row) => [row.submissionStatus],
    stage: (row) => [row.stage], batch: (row) => row.batchIds,
  };
  const missingDimensionLabels: Partial<Record<AnalyticsQuery['dimension'], { key: string; label: string }>> = {
    company: { key: 'empresa_desconhecida', label: 'Empresa desconhecida' }, title: { key: 'titulo_desconhecido', label: 'Título desconhecido' },
    stack: { key: 'sem_stack_informada', label: 'Sem stack informada' }, seniority: { key: 'senioridade_desconhecida', label: 'Senioridade desconhecida' },
    modality: { key: 'modalidade_desconhecida', label: 'Modalidade desconhecida' }, channel: { key: 'canal_desconhecido', label: 'Canal desconhecido' },
    platform: { key: 'plataforma_desconhecida', label: 'Plataforma desconhecida' }, batch: { key: 'sem_lote_informado', label: 'Sem lote informado' },
  };
  const selectedGrouping = { dimension: query.dimension, groups: makeGroups(dimensionKeys[query.dimension], query.dimension === 'stack' || query.dimension === 'batch', missingDimensionLabels[query.dimension]) };
  const daily: SeriesPoint[] = [];
  const weeks = new Map<string, SeriesPoint>();
  const submissionsByDay = new Map<string, AnalyticsRow[]>();
  for (const row of submissionCohort) {
    const day = toLocalDay(row.submittedDate)!;
    const members = submissionsByDay.get(day) ?? [];
    members.push(row);
    submissionsByDay.set(day, members);
  }
  for (let offset = 0; offset <= duration; offset++) {
    const day = addCivilDays(query.period.from, offset);
    const members = submissionsByDay.get(day) ?? [];
    const point = { day, ...rowPopulation('Envios confirmados no dia', members), goal: query.dailyGoal, difference: members.length - query.dailyGoal };
    daily.push(point);
    const monday = mondayOfWeek(day);
    const week = weeks.get(monday) ?? { day: monday, ...population('Envios confirmados na semana', []), goal: 0, difference: 0 };
    const ids = [...week.applicationIds, ...point.applicationIds].sort();
    weeks.set(monday, { ...week, applicationIds: ids, count: ids.length, goal: week.goal + query.dailyGoal, difference: ids.length - week.goal - query.dailyGoal });
  }
  const periodEvents = events.filter((event) => inPeriod(toLocalDay(event.occurredDate)));
  return {
    asOf: query.asOf, query,
    populations: { selected: rowPopulation(({ confirmed: 'Confirmadas', saved: 'Salvas', unknown: 'Envio não confirmado', all: 'Todos os estados de envio' })[query.population], selected), allConfirmed: rowPopulation('Confirmadas elegíveis em todas as datas', allConfirmed), submissionCohort: rowPopulation('Confirmadas enviadas no período', submissionCohort), conversionCohort: rowPopulation(query.submissionScope === 'all_dates' ? 'Conversão: todas as datas' : 'Conversão: envios no período', cohort), cycle: rowPopulation('Confirmadas após reinício com ordem atribuída', allConfirmed.filter((row) => row.cycleRelation === 'after_reset' && row.cycleOrder !== null)) },
    coverage: { precision: groupCoverage(allConfirmed, (row) => row.submittedDate.precision), certainty: groupCoverage(allConfirmed, (row) => row.submittedDate.precision === 'unknown' ? 'unknown' : row.submittedDate.certainty), missing: { submittedDay: rowPopulation('Sem dia exato de envio', allConfirmed.filter((row) => toLocalDay(row.submittedDate) === null)), sentCv: rowPopulation('Sem CV enviado informado', allConfirmed.filter((row) => row.resumeIds.length === 0)) } },
    conversions: conversionsFor(cohort), completed,
    groups: { stack: makeGroups(dimensionKeys.stack, true, { key: 'sem_stack_informada', label: 'Sem stack informada' }), discoveryChannel: makeGroups(dimensionKeys.channel, false, { key: 'canal_desconhecido', label: 'Canal desconhecido' }), submissionPlatform: makeGroups(dimensionKeys.platform, false, { key: 'plataforma_desconhecida', label: 'Plataforma desconhecida' }), sentCv: makeGroups((row) => row.resumeIds, true, { key: 'sem_cv_informado', label: 'Sem CV enviado informado' }) },
    selectedGrouping,
    daily, weekly: [...weeks.values()], comparison: { actual: submissionCohort.length, goal: (duration + 1) * query.dailyGoal, difference: submissionCohort.length - (duration + 1) * query.dailyGoal, applicationIds: submissionCohort.map((row) => row.id).sort() },
    eventsInPeriod: { applicationIds: [...new Set(periodEvents.map((event) => event.applicationId))].sort(), eventIds: periodEvents.map((event) => event.id).sort(), categories: Object.fromEntries(categories.map((name) => [name, population('Eventos no período', [...categoryIds(periodEvents, name)])])) as Record<ReachedCategory, Population> },
    effectiveEventIds: events.map((event) => event.id).sort(), supersededEventIds: known.filter((event) => superseded.has(event.id) && selectedIds.has(canonicalId(event.applicationId))).map((event) => event.id).sort(),
    eventAttribution: known.filter((event) => selectedIds.has(canonicalId(event.applicationId))).map((event) => ({ eventId: event.id, originalApplicationId: event.applicationId, canonicalApplicationId: canonicalId(event.applicationId) })).sort((a, b) => a.eventId.localeCompare(b.eventId)),
    firstReturn: firstReturn(cohort, events),
  };
}
