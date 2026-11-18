import { describe, expect, it } from 'vitest';
import { addCivilDays, civilDaysBetween, mondayOfWeek, toLocalDay } from '../../domain/dates';

describe('Gregorian Sao Paulo business dates', () => {
  it('converts instants across the local boundary without inventing imprecise days', () => {
    expect(toLocalDay({ precision: 'instant', certainty: 'exact', value: '2026-11-15T01:30:00Z' })).toBe('2026-11-14');
    expect(toLocalDay({ precision: 'day', certainty: 'exact', value: '2026-11-15' })).toBe('2026-11-15');
    expect(toLocalDay({ precision: 'day', certainty: 'approximate', value: '2026-11-15' })).toBeNull();
    expect(toLocalDay({ precision: 'month', certainty: 'exact', value: '2026-11' })).toBeNull();
    expect(toLocalDay({ precision: 'year', certainty: 'exact', value: '2026' })).toBeNull();
    expect(toLocalDay({ precision: 'unknown', value: null })).toBeNull();
  });
  it('uses civil arithmetic across DST, leap days and early years', () => {
    expect(toLocalDay({ precision: 'instant', certainty: 'exact', value: '2018-11-05T02:30:00Z' })).toBe('2018-11-05');
    expect(civilDaysBetween('2018-11-03', '2018-11-05')).toBe(2);
    expect(civilDaysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(addCivilDays('0099-12-31', 1)).toBe('0100-01-01');
    expect(addCivilDays('0001-01-01', 1)).toBe('0001-01-02');
    expect(mondayOfWeek('2026-11-15')).toBe('2026-11-09');
  });
});

it('rejects converted civil days outside AD 0001 through 9999 instead of fabricating an era', () => {
  expect(() => toLocalDay({ precision: 'instant', certainty: 'exact', value: '0001-01-01T00:00:00Z' })).toThrow(RangeError);
  expect(() => toLocalDay({ precision: 'instant', certainty: 'exact', value: '9999-12-31T23:30:00-05:00' })).toThrow(RangeError);
  expect(toLocalDay({ precision: 'instant', certainty: 'exact', value: '0001-01-02T12:00:00Z' })).toBe('0001-01-02');
  expect(toLocalDay({ precision: 'instant', certainty: 'exact', value: '9999-12-31T12:00:00Z' })).toBe('9999-12-31');
});
