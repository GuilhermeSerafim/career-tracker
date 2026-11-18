/** Esta política HTTP não usa default-src: a meta adiciona o connect-src exato.
 * Políticas CSP se intersectam; default-src self aqui bloquearia o Auth remoto. */
export const PAGE_HEADER_CSP =
  "script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function publicAuthOrigin(raw: string | undefined, local: boolean): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw Error();
    if (!/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(url.hostname) && url.hostname !== '[::1]')
      throw Error();
    if (
      url.protocol !== 'https:' &&
      !(
        local &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      )
    )
      throw Error();
    return url.origin;
  } catch {
    throw Error('Origem pública de autenticação inválida.');
  }
}
export function pageMetaCsp(origin: string | null) {
  return `default-src 'self'; connect-src 'self'${origin ? ' ' + origin : ''}; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; worker-src 'none'`;
}
