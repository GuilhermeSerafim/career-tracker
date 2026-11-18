import { describe, expect, it } from 'vitest';
import { LEGACY_HEADER, parseLegacyCsv, readLegacyCsvRecords } from '../../domain/import';
import { MAX_SOURCE_ARCHIVE_BYTES } from '../../shared/transfer';

const header = LEGACY_HEADER.join(',') + '\r\n';
function rawRecord(characters: number, fill = 'é') {
  const fields = ['V1', 'Empresa Fictícia', 'Backend', '', '', '', '', '', 'confirmado', '', '', '', '', '', 'Fixture', '', '2026-11-10'];
  const encode = () => fields.map((value) => `"${value.replaceAll('"', '""')}"`).join(',') + '\r\n';
  fields[15] = fill.repeat(characters - encode().length);
  return encode();
}

describe('limites explícitos sem truncamento do legado', () => {
  it.each([49_999, 50_000, 50_001])('limita registro bruto de %i caracteres incluindo aspas/CRLF', (characters) => {
    const record = rawRecord(characters);
    expect(record.length).toBe(characters);
    const result = parseLegacyCsv(header + record);
    expect(result.blocked).toBe(characters > 50_000);
    if (characters <= 50_000) expect(result.rows[0]?.raw).toBe(record);
    else expect(result.issues.map((issue) => issue.code)).toContain('record_too_large');
  });

  it('rejeita campo de 16 MiB pelo limite do parser, sem projetar/truncar o registro', () => {
    const result = parseLegacyCsv(header + rawRecord(16 * 1024 * 1024, 'x'));
    expect(result.blocked).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain('record_too_large');
  });

  it.each([-1, 0, 1])('limite externo de arquivo: 50 MiB com ajuste de %i bytes', (delta) => {
    const result = parseLegacyCsv(Buffer.alloc(MAX_SOURCE_ARCHIVE_BYTES + delta, 'x'));
    expect(result.issues.some((issue) => issue.code === 'source_too_large')).toBe(delta > 0);
    expect(result.rows).toEqual([]);
  });

  it('campos vazios não contornam o limite de buffers do parser', () => {
    const result = parseLegacyCsv(header + ','.repeat(500_000));
    expect(result.blocked).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain('invalid_csv');
  });

  it.each([99_999, 100_000, 100_001])('limita %i registros CSV, sem contar cabeçalho', (count) => {
    const row = rawRecord(150, 'x');
    const bytes = Buffer.from(header + row.repeat(count));
    if (count <= 100_000) expect(readLegacyCsvRecords(bytes)).toHaveLength(count + 1);
    else {
      expect(() => readLegacyCsvRecords(bytes)).toThrow('row_limit');
      const result = parseLegacyCsv(bytes);
      expect(result.rows).toEqual([]);
      expect(result.issues.map((issue) => issue.code)).toContain('row_limit');
    }
  }, 30_000);
});
