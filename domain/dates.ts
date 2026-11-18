import { TIME_ZONE, type DateValue } from '../shared/model.js';

const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Preserva os 1–9 dígitos fracionários do instante já validado pelo contrato.
 * Date calcula apenas o segundo integral e seu offset; BigInt preserva a fração, inclusive antes de 1970. */
export function instantNanoseconds(value: string): bigint {
  const fraction = value.match(/\.(\d{1,9})(?=Z|[+-])/)?.[1] ?? '';
  const integralSecond = value.replace(/\.\d{1,9}(?=Z|[+-])/, '');
  return BigInt(Date.parse(integralSecond)) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
}
/** Conversões para fora de AD 0001–9999 falham explicitamente; não inventam um dia suportado. */
export function toLocalDay(value: DateValue): string | null {
  if (value.precision === 'unknown' || value.certainty !== 'exact') return null;
  if (value.precision === 'day') return value.value;
  if (value.precision !== 'instant') return null;
  const parts = formatter.formatToParts(new Date(value.value));
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  if (part('era') !== 'AD' || Number(part('year')) > 9999) throw new RangeError('O dia local deve estar entre os anos 0001 e 9999 da era comum.');
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

// UTC is only a carrier for Gregorian arithmetic, never a local midnight.
function civilDate(day: string): Date {
  const date = new Date(0);
  date.setUTCFullYear(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return date;
}
export function civilDaysBetween(from: string, to: string): number {
  return (civilDate(to).getTime() - civilDate(from).getTime()) / 86_400_000;
}
export function addCivilDays(day: string, amount: number): string {
  const date = civilDate(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export function mondayOfWeek(day: string): string {
  return addCivilDays(day, -((civilDate(day).getUTCDay() + 6) % 7));
}
