import type { Page } from '@playwright/test';
import type { syntheticCareerApi } from './synthetic-career';

export async function syntheticBrowser(page: Page, api: Awaited<ReturnType<typeof syntheticCareerApi>>, options: { seed?: boolean; contextRoutes?: boolean; sessionIdentity?: 'missing' | 'malformed' } = {}) {
  const origin = 'http://127.0.0.1:4173';
  const authOrigin = 'http://127.0.0.1:54321';
  const user = { id: api.owner, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const identity = () => options.sessionIdentity === 'missing' ? {} : { session_id: options.sessionIdentity === 'malformed' ? 'synthetic-invalid' : crypto.randomUUID() };
  const session = { access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', exp: expires, ...identity() })}.synthetic-signature`, refresh_token: 'synthetic-refresh', expires_in: 3600, expires_at: expires, token_type: 'bearer', user };
  let loginNumber = 0;
  let unavailable = false;
  let loseSave = false;
  let lostOperation = 'save_application';
  let failDetail = false;
  let expireRead: string | null = null;
  const writes: { body: string; key: string | undefined; status: number }[] = [];
  const apiReads: { path: string; status: number }[] = [];
  await page.clock.setFixedTime(new Date('2026-11-16T01:30:00Z'));
  if (options.seed !== false) await page.context().addInitScript(({ origin, session }) => {
    if (location.origin === origin && !localStorage.getItem('synthetic-e2e-seeded')) {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session)); localStorage.setItem('synthetic-e2e-seeded', 'true');
    }
  }, { origin, session });
  await (options.contextRoutes ? page.context() : page).route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === authOrigin) {
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'content-type': 'application/json' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.pathname === '/auth/v1/user') return route.fulfill({ status: 200, headers, body: JSON.stringify(user) });
      if (url.pathname === '/auth/v1/token') {
        // Each successful login has a distinct session, as with hosted Auth.
        loginNumber++;
        const fresh = { ...session, access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', exp: expires, ...identity(), syntheticLogin: loginNumber })}.synthetic-signature`, refresh_token: `synthetic-refresh-${loginNumber}` };
        return route.fulfill({ status: 200, headers, body: JSON.stringify(fresh) });
      }
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers });
      return route.fulfill({ status: 404, headers, body: '{}' });
    }
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/v1/')) return route.continue();
    // Test-only loopback forwarding into createApp + career_api PostgreSQL.
    // The browser's current guarded SDK Bearer is forwarded, never replaced.
    const rejectDetail = failDetail && /^\/api\/v1\/applications\/[^/]+$/.test(url.pathname); if (rejectDetail) failDetail = false;
    api.unavailable(unavailable && url.pathname === '/api/v1/today' || rejectDetail);
    try {
      const expire = request.method() === 'GET' && url.pathname === expireRead; if (expire) expireRead = null;
      const response = await api.request(url.pathname + url.search, { method: request.method(), headers: { ...(!expire ? { authorization: request.headers().authorization } : {}), ...(request.method() === 'POST' ? { 'content-type': request.headers()['content-type'], ...(request.headers()['idempotency-key'] ? { 'idempotency-key': request.headers()['idempotency-key'] } : {}) } : {}) }, body: request.postData() ?? undefined });
      if (request.method() === 'POST') {
        writes.push({ body: request.postData()!, key: request.headers()['idempotency-key']!, status: response.status });
        const command = JSON.parse(request.postData()!);
        if (loseSave && (command.operation ?? command.unit) === lostOperation && response.status < 300) { loseSave = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{}}' }); }
      }
      apiReads.push({ path: url.pathname, status: response.status });
      const headers = Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !['connection', 'transfer-encoding', 'content-length'].includes(entry[0])));
      return await route.fulfill({ status: response.status, headers, body: response.text });
    } finally { api.unavailable(false); }
  });
  return { failToday: (value: boolean) => { unavailable = value; }, loseNextSave: (operation = 'save_application') => { loseSave = true; lostOperation = operation; }, failNextDetail: () => { failDetail = true; }, expireNextList: () => { expireRead = '/api/v1/applications'; }, expireNextRead: (path: string) => { expireRead = path; }, apiReads, writes };
}
