import { describe, expect, it } from 'vitest';
import { applicationIdentity, normalizeJobUrl, normalizeTrack } from '../../domain/identity';

describe('identidade conservadora', () => {
  it('retira somente rastreamento conhecido e conserva identificadores, fragmento e caminho', () => {
    const originalUrl = 'https://jobs.example.org/Open?token=opaque&jobId=42&utm_source=x&gh_src=y&jobBoardSource=z#Job42';
    expect(normalizeJobUrl(originalUrl)).toBe('https://jobs.example.org/Open?jobId=42&token=opaque#Job42');
    expect(normalizeJobUrl('https://jobs.example.org/open?jobId=42&utm_source=x&gh_src=y')).toBe('https://jobs.example.org/open?jobId=42');
  });
  it('recusa esquemas ativos e URLs inválidas sem buscar destinos', () => {
    for (const url of ['javascript:alert(1)', 'file:///private', 'ftp://example.org', 'invalid']) expect(() => normalizeJobUrl(url)).toThrow();
  });
  it('recusa usuário ou senha embutidos, inclusive codificados, sem alterar tokens de consulta', () => {
    for (const authority of ['fictional-user:fictional-password', 'fictional-user', ':fictional-password', '%75ser:%70ass']) {
      expect(() => normalizeJobUrl(`https://${authority}@jobs.example.org/Open?token=opaque#Job42`)).toThrow();
    }
    expect(normalizeJobUrl('http://jobs.example.org/Open?token=opaque&utm_source=x#Job42')).toBe('http://jobs.example.org/Open?token=opaque#Job42');
  });
  it('normaliza apenas espaços ASCII e NBSP, preservando caixa e espaços Unicode restantes', () => {
    expect(normalizeTrack('\t AI  Engineer\r\n\u00a0')).toBe('AI Engineer');
    expect(normalizeTrack(null)).toBe(''); expect(normalizeTrack(' \t')).toBe('');
    expect(normalizeTrack('AI\u2003Engineer')).toBe('AI\u2003Engineer');
    expect(normalizeTrack('ai engineer')).not.toBe(normalizeTrack('AI Engineer'));
  });
  it('serializa tupla sem ambiguidades e usa ocorrência inicial estável', () => {
    expect(applicationIdentity('id', null)).toBe(applicationIdentity('id', ' \t', 'initial'));
    expect(applicationIdentity('id:a', 'b')).not.toBe(applicationIdentity('id', 'a:b'));
    expect(applicationIdentity('id', 'AI Builder')).not.toBe(applicationIdentity('id', 'AI Engineer'));
  });
});
