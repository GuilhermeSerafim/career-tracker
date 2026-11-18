export type SafeReference = { kind: 'external'; href: string } | { kind: 'local'; reference: string } | { kind: 'invalid' };
/** Classification only. Callers must not put original URLs in notifications/logs. */
export function safeReference(value: string, isLocal = false): SafeReference {
  const control = Array.from(value).some((character) => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; });
  if (!value.trim() || value.length > 4096 || control) return { kind: 'invalid' };
  if (isLocal) return { kind: 'local', reference: value };
  if (!/^https?:\/\/[^/?#]+/i.test(value) || /\s/.test(value) || value.includes('\\') || /^https?:\/\/[^/?#]*@/i.test(value)) return { kind: 'invalid' };
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return { kind: 'invalid' };
    return { kind: 'external', href: value };
  } catch { return { kind: 'invalid' }; }
}
