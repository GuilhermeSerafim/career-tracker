import { describe, expect, it } from 'vitest';
import { safeReference } from './links';

describe('safe references', () => {
  it('preserves the original HTTP(S) URL including tokens without using it as a label', () => {
    const url = 'https://example.invalid/private?token=synthetic#section';
    expect(safeReference(url)).toEqual({ kind: 'external', href: url });
    expect(safeReference('http://localhost:3000/path')).toEqual({ kind: 'external', href: 'http://localhost:3000/path' });
  });
  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)',
    'java\nscript:alert(1)', '\u0000https://example.invalid', ' javascript:alert(1)',
    '%6a%61vascript:alert(1)', 'https%3a%2f%2fexample.invalid', 'https://u:p@example.invalid',
    'https://u%40name@example.invalid', 'https://example.invalid:bad', 'https://', '//example.invalid',
    'https:example.invalid', 'https://example.invalid\\@other.invalid', 'https://exa mple.invalid',
    'file:///C:/private.txt', '[open](javascript:alert(1))', '<script>alert(1)</script>'])('rejects unsafe/malformed reference %j', (url) => {
    expect(safeReference(url)).toEqual({ kind: 'invalid' });
  });
  it('requires an explicit local classification and never produces an href for local files', () => {
    expect(safeReference('C:\\Documents\\note.txt')).toEqual({ kind: 'invalid' });
    expect(safeReference('C:\\Documents\\note.txt', true)).toEqual({ kind: 'local', reference: 'C:\\Documents\\note.txt' });
  });
});
