import type { AppRuntime } from '../../app/runtime';
import { ApiError } from '../../lib/api';
import type { ApplicationResult } from '../../../shared/application-results';
import type { AnalyticsEvent } from '../../../shared/analytics';
import type { DateValue } from '../../../shared/model';

// GET /today's existing read-route projection; labels come from authorized reads.
type TodayEvent = AnalyticsEvent & { canonicalApplicationId: string };
export interface TodayResult {
  date: string;
  asOf: string;
  dailyGoal: number;
  submitted: { count: number; applicationIds: string[] };
  tasks: { id: string; applicationId: string | null; contactId: string | null; title: string; dueDate: DateValue; dueDay: string | null; dueGroup: 'overdue' | 'today' | 'future' | 'no_exact_deadline' }[];
  recentEvents: TodayEvent[];
  historicalResults: TodayEvent[];
  unknownDateApplicationIds: string[];
}
export type Application = NonNullable<ApplicationResult['application']>;
export interface Contact { id: string; version: number; name: string | null; notes: string | null; links: { originalUrl: string; isLocal: boolean }[] }
export function localDay(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function displayDate(date: DateValue, timezone: string): string {
  if (date.precision === 'unknown') return 'Data desconhecida';
  let text: string;
  if (date.precision === 'instant') text = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(date.value));
  else if (date.precision === 'day') text = date.value.split('-').reverse().join('/');
  else if (date.precision === 'year') text = date.value;
  else {
    const months = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    text = `${months[Number(date.value.slice(5)) - 1]} de ${date.value.slice(0, 4)}`;
  }
  return date.certainty === 'approximate' ? `${text} (aproximado)` : text;
}
export async function readToday(runtime: AppRuntime) {
  const settings = await runtime.api.read<{ timezone: string }>('/api/v1/settings');
  const date = localDay(new Date(), settings.timezone);
  const today = await runtime.api.read<TodayResult>(`/api/v1/today?date=${date}`);
  if (!Number.isSafeInteger(today.dailyGoal) || today.dailyGoal <= 0 || !Number.isSafeInteger(today.submitted.count) || today.submitted.count < 0) throw new ApiError(503);
  const historical = [...today.historicalResults].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id)).slice(0, 5);
  const historicalIds = new Set(today.historicalResults.map((event) => event.id));
  const recent = today.recentEvents.filter((event) => !historicalIds.has(event.id)).slice(0, 5);
  const ids = [...new Set([...today.tasks.map((task) => task.applicationId), ...recent.map((event) => event.canonicalApplicationId), ...historical.map((event) => event.canonicalApplicationId)].filter((id): id is string => id !== null))];
  const applications = new Map<string, Application>();
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const response = await runtime.api.read<{ items: Application[] }>(`/api/v1/applications?limit=100&ids=${encodeURIComponent(JSON.stringify(batch))}`);
    response.items.forEach((application) => applications.set(application.id, application));
    if (batch.some((id) => !applications.has(id))) throw new ApiError(503);
  }
  return { today, timezone: settings.timezone, applications, recent, historical };
}
