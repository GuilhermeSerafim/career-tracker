/** Mesmo conjunto explícito do SQL: ASCII whitespace e NBSP; preserva caixa. */
export function normalizeTrack(track: string | null): string { return (track ?? '').replace(/[ \t\n\r\f\v\u00a0]+/g, ' ').replace(/^ | $/g, ''); }
export function applicationIdentity(opportunityId: string, track: string | null, occurrence = 'initial'): string {
  return JSON.stringify([opportunityId, normalizeTrack(track), occurrence]);
}
export function normalizeJobUrl(originalUrl: string): string {
  const url = new URL(originalUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /\s/u.test(originalUrl)) throw new Error('URL HTTP(S) inválida.');
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || key === 'gh_src' || key === 'jobBoardSource') url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}
