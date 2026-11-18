import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareLegacyRows, parseLegacyCsv, LEGACY_HEADER } from '../../domain/import';

const header = 'id,empresa,cargo,plataforma,codigo_vaga,chave_vaga,url_original,links_alternativos,status_envio,data_envio,evidencia_envio,cv_enviado,etapa,ordem_ciclo,fonte,observacoes,registrado_em';
const raw = 'V901,"Empresa, Exemplo",Backend,ATS Exemplo,42,chave42,https://jobs.example.org/42,"file:///privado/a.pdf | javascript:alert(1)",confirmado,,Relato fictício,"CV A.pdf | CV B.pdf","Talvez entrevista, sem confirmação",1,Fixture,"  ação 🧭 ""citada""\r\nsegunda linha  ",2026-11-10\r\n';
const source = Buffer.from('\ufeff' + header + '\r\n' + raw, 'utf8');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

describe('arquivo legado fictício', () => {
  it('preserva bytes BOM/CRLF, campos UTF-8, IDs e hash exato da linha', () => {
    const parsed = parseLegacyCsv(source);
    expect(LEGACY_HEADER.join(',')).toBe(header);
    expect(parsed.sourceHash).toBe(hash(source));
    const row = parsed.rows[0]!;
    expect(row.rawRowHash).toBe(hash(Buffer.from(raw, 'utf8')));
    expect(row.raw).toBe(raw);
    expect(row.fields.observacoes).toBe('  ação 🧭 "citada"\r\nsegunda linha  ');
    expect(row).toMatchObject({ legacyId: 'V901', company: 'Empresa, Exemplo', submissionStatus: 'confirmado', submittedDate: { precision: 'unknown', value: null }, legacyRegisteredDate: { precision: 'day', certainty: 'exact', value: '2026-11-10' }, stage: 'desconhecida', stageNarrative: 'Talvez entrevista, sem confirmação', legacyPlatform: 'ATS Exemplo', discoveryChannel: null, submissionPlatform: null, tenant: null, legacyResumeText: 'CV A.pdf | CV B.pdf', cycleOrder: 1 });
    expect(row.provenance.observacoes).toEqual({ column: 'observacoes', rawRowHash: row.rawRowHash, originalText: row.fields.observacoes });
    expect(row.links.map((link) => link.classification)).toEqual(['web', 'local', 'dangerous']);
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'dangerous_reference', severity: 'warning' }), expect.objectContaining({ code: 'unknown_submission_date', severity: 'warning' })]));
    expect(parsed.blocked).toBe(false);
    expect(parseLegacyCsv(source.toString('utf8'))).toEqual(parsed);
  });

  it('fixture pública contém somente os dados fictícios esperados e bytes multibyte', () => {
    const fixture = readFileSync(new URL('../fixtures/legacy.csv', import.meta.url));
    expect(fixture.equals(source)).toBe(true);
    expect(fixture.subarray(0, 3).toString('hex')).toBe('efbbbf');
    expect(fixture.includes(Buffer.from([0xf0, 0x9f, 0xa7, 0xad]))).toBe(true);
  });

  it.each([
    ['utf8', Buffer.from([0xff]), 'invalid_utf8'],
    ['csv', Buffer.from(header + '\n"aberto'), 'invalid_csv'],
    ['header', Buffer.from(header.replace('empresa', 'Company') + '\n' + raw), 'invalid_header'],
    ['status', Buffer.from(header + '\n' + raw.replace('confirmado,,', 'talvez,,')), 'invalid_status'],
    ['date', Buffer.from(header + '\n' + raw.replace('confirmado,,', 'confirmado,2026-02-30,')), 'invalid_date'],
    ['id', Buffer.from(header + '\n' + raw.replace('V901,', ',')), 'invalid_id'],
    ['order', Buffer.from(header + '\n' + raw.replace(',1,Fixture', ',1.5,Fixture')), 'invalid_order'],
  ])('bloqueia %s sem perder o hash do arquivo', (_, bytes, code) => {
    const result = parseLegacyCsv(bytes);
    expect(result.sourceHash).toBe(hash(bytes));
    expect(result.blocked).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code, severity: 'error' })]));
  });

  it('bloqueia IDs/ordens repetidos e apenas alerta sobre possíveis candidaturas duplicadas', () => {
    const result = parseLegacyCsv(header + '\r\n' + raw + raw + raw.replace('V901,', 'V902,').replace(',1,Fixture', ',2,Fixture'));
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['duplicate_id', 'duplicate_order', 'possible_duplicate']));
    expect(result.blocked).toBe(true);
  });

  it('diff protege a versão da aplicação alterada desde a importação, inclusive em conflito', () => {
    const row = parseLegacyCsv(source).rows[0]!;
    const state = { legacyId: row.legacyId, rawRowHash: row.rawRowHash, importedApplicationVersion: 2, currentApplicationVersion: 2 };
    expect(compareLegacyRows([row], [])).toEqual([{ legacyId: 'V901', kind: 'new' }]);
    expect(compareLegacyRows([row], [state])[0]?.kind).toBe('unchanged');
    expect(compareLegacyRows([row], [{ ...state, rawRowHash: 'a'.repeat(64) }])[0]?.kind).toBe('source_changed');
    expect(compareLegacyRows([row], [{ ...state, currentApplicationVersion: 3 }])[0]?.kind).toBe('application_changed');
    expect(compareLegacyRows([row], [{ ...state, rawRowHash: 'a'.repeat(64), currentApplicationVersion: 3 }])[0]?.kind).toBe('conflict');
    expect(() => compareLegacyRows([row], [state, state])).toThrow();
    expect(() => compareLegacyRows([row, row], [])).toThrow();
    expect(compareLegacyRows([], [state])).toEqual([{ legacyId: 'V901', kind: 'source_missing' }]);
  });

  it('preserva fronteiras de múltiplas linhas e último registro sem terminador', () => {
    const final = raw.replace('V901,', 'V902,').replace(',1,Fixture', ',2,Fixture').slice(0, -2);
    const bytes = Buffer.from('\ufeff' + header + '\r\n' + raw + final);
    const result = parseLegacyCsv(bytes);
    expect(result.rows.map((row) => row.rawRowHash)).toEqual([hash(raw), hash(final)]);
    expect(result.rows[0]?.byteStart).toBe(Buffer.byteLength('\ufeff' + header + '\r\n'));
    expect(result.rows[1]?.byteEnd).toBe(bytes.length);
  });

  it('arquiva valores __proto__ e whitespace sem conversões implícitas', () => {
    const text = raw.replace('Backend,ATS', '__proto__,ATS').replace('Relato fictício', '  constructor __proto__  ');
    const row = parseLegacyCsv(header + '\r\n' + text).rows[0]!;
    expect(row.title).toBe('__proto__');
    expect(row.fields.evidencia_envio).toBe('  constructor __proto__  ');
    expect(row.provenance.evidencia_envio.originalText).toBe('  constructor __proto__  ');
  });

  it.each(['confirmado', 'nao_confirmado', 'nao_enviado'])('mantém estado %s sem deduzir envio a partir da data de registro', (status) => {
    const row = parseLegacyCsv(header + '\r\n' + raw.replace('confirmado,,', `${status},,`).replace(',1,Fixture', ',,Fixture')).rows[0]!;
    expect(row.submissionStatus).toBe(status);
    expect(row.submittedDate).toEqual({ precision: 'unknown', value: null });
    expect(row.cycleOrder).toBeNull();
  });
});
