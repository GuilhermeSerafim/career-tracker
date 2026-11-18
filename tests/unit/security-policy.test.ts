import { describe, expect, it } from 'vitest';
import { PAGE_HEADER_CSP, pageMetaCsp, publicAuthOrigin } from '../../server/security-policy';
describe('CSP público com origem Auth exata', () => {
  it('limita conexões a mesma origem e ao Auth validado', () => {
    const origin = publicAuthOrigin('https://synthetic.supabase.co', false);
    expect(pageMetaCsp(origin)).toContain("connect-src 'self' https://synthetic.supabase.co;");
    expect(PAGE_HEADER_CSP).toContain("frame-ancestors 'none'");
    expect(PAGE_HEADER_CSP).not.toContain('default-src');
    expect(pageMetaCsp(null)).toContain("connect-src 'self';");
  });
  it.each([
    'https://user:secret@example.test',
    'https://example.test/path',
    'https://example.test?x=1',
    'https://example.test#x',
    'http://remote.test',
    'https://x;script-src.test',
    'https://*.supabase.co',
    'invalid',
  ])('rejeita origem insegura %s', (raw) => {
    expect(() => publicAuthOrigin(raw, false)).toThrow('Origem pública');
  });
  it('HTTP loopback exige ambiente local explícito', () => {
    expect(publicAuthOrigin('http://127.0.0.1:54321', true)).toBe('http://127.0.0.1:54321');
    expect(() => publicAuthOrigin('http://127.0.0.1:54321', false)).toThrow();
  });
});
