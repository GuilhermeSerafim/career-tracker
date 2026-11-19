import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type Request } from '@playwright/test';
import { syntheticCareerApi } from '../helpers/synthetic-career';
import { syntheticBrowser } from '../helpers/synthetic-browser';
import { parse } from 'csv-parse/sync';

let api: Awaited<ReturnType<typeof syntheticCareerApi>>;
test.beforeEach(async () => { api = await syntheticCareerApi(); });
test.afterEach(async ({ context }) => {
  try {
    // A final navigation can still issue API reads after the shell is visible.
    await context.close();
  } finally {
    await api?.close();
  }
});
async function login(page: Page) {
  await page.getByLabel('E-mail', { exact: true }).fill('synthetic@example.invalid');
  await page.getByLabel('Senha', { exact: true }).fill('synthetic-password-only');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}
async function logout(page: Page) {
  await page.getByRole('button', { name: 'Conta', exact: true }).click();
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
}

test('conteúdo não confiável: esquemas recusados, texto literal, rótulo privado e CSV seguro', async ({ page }) => {
  await syntheticBrowser(page, api);
  const audits = await api.auditCount();
  for (const originalUrl of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://user:synthetic@example.invalid/']) {
    const rejected = await api.post({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: 'Contato fictício', notes: null, links: [{ originalUrl, comparisonUrl: null, kind: 'referencia', isLocal: false, isPrivate: true }] } });
    expect(rejected.status).toBe(400);
  }
  expect(await api.auditCount()).toBe(audits);
  let dialogs = 0; page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
  await page.goto('/vagas/nova');
  await page.getByLabel('Empresa', { exact: true }).fill('  =SUM(1,2)');
  const literal = '<img src=x onerror=alert(1)> [abrir](javascript:alert(1))';
  await page.getByLabel('Cargo', { exact: true }).fill(literal);
  await page.getByLabel('Link original e alternativos (um por linha)').fill('https://example.test/private?token=synthetic-private-reference');
  await page.getByLabel('Relato ou evidência', { exact: true }).fill('Relato fictício.');
  await page.getByRole('button', { name: 'Registrar candidatura', exact: true }).click();
  await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Abrir registro salvo', exact: true }).click();
  await expect(page.getByText(literal, { exact: true })).toBeVisible();
  await expect(page.locator('main img, main script, main a[href^="javascript:"], main a[href^="data:"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('synthetic-private-reference');
  const reference = page.locator('a[href*="synthetic-private-reference"]');
  await expect(reference).toHaveAttribute('rel', 'noopener noreferrer'); await expect(reference).toHaveAttribute('referrerpolicy', 'no-referrer');
  const csv = await api.request('/api/v1/exports?format=csv', { headers: api.headers }); expect(csv.status).toBe(200);
  const rows = parse<Record<string, string>>(csv.text, { columns: true }); expect(rows[0]!.empresa).toMatch(/^'\s*=SUM\(1,2\)$/);
  expect(dialogs).toBe(0);
});

test('credencial nativa: exibição única, agente real, atores, expiração e revogação', async ({ page }) => {
  const browser = await syntheticBrowser(page, api);
  await page.goto('/configuracoes');
  await page.getByLabel('Nome da credencial').fill('Agente sintético descartável');
  await page.getByLabel('Registrar carreira', { exact: true }).check();
  await page.getByRole('button', { name: 'Criar credencial', exact: true }).focus();
  await page.keyboard.press('Enter');
  const secret = page.getByRole('textbox', { name: 'Credencial exibida uma vez' });
  await expect(secret).toBeVisible();
  await secret.focus();
  expect(await secret.evaluate((node: HTMLTextAreaElement) => node.readOnly && node.selectionStart === 0 && node.selectionEnd === node.value.length)).toBe(true);
  const token = await secret.inputValue();
  expect(/^ct_agent_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
  const agentHeaders = { authorization: `Bearer ${token}` };
  expect((await api.request('/api/v1/health', { headers: agentHeaders })).status).toBe(200);
  expect((await api.request('/api/v1/exports?format=json', { headers: agentHeaders })).status).toBe(403);
  expect(await page.evaluate(value => Object.values(localStorage).some(item => item.includes(value)) || Object.values(sessionStorage).some(item => item.includes(value)), token)).toBe(false);
  await page.getByRole('button', { name: 'Guardei em local privado; ocultar' }).click();
  await expect(secret).toHaveCount(0);
  await page.goto('/vagas/nova');
  await page.getByLabel('Empresa', { exact: true }).fill('Empresa de convergência fictícia');
  await page.getByLabel('Cargo', { exact: true }).fill('Engenharia');
  await page.getByLabel('Relato ou evidência', { exact: true }).fill('Envio fictício do proprietário.');
  await page.getByRole('button', { name: 'Registrar candidatura', exact: true }).click();
  await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
  const listing = await api.request('/api/v1/applications?view=confirmed&limit=100', { headers: agentHeaders });
  expect(listing.status).toBe(200); expect(listing.json.total).toBe(1);
  const application = listing.json.items[0];
  const response = await api.request('/api/v1/commands', { method: 'POST', headers: { ...agentHeaders, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ operation: 'record_event', clientId: randomUUID(), application: { id: application.id, expectedVersion: application.version }, data: { kind: 'avaliacao', state: 'concluido', occurredDate: { precision: 'unknown', value: null }, resultText: 'Avaliação fictícia registrada pelo agente', scoreValue: null, scoreUnit: null, sourceText: null, evidence: null } }) });
  expect(response.status).toBe(201);
  await page.getByRole('link', { name: 'Abrir registro salvo', exact: true }).click();
  await expect(page.getByText('Avaliação fictícia registrada pelo agente', { exact: true })).toBeVisible();
  const actors = await api.auditActors();
  expect(actors.some(actor => actor.actor_kind === 'owner' && actor.actor_id === api.owner)).toBe(true);
  expect(actors.some(actor => actor.actor_kind === 'agent' && actor.actor_id === token.slice(9, 45))).toBe(true);
  await page.goto('/configuracoes'); await expect(secret).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revogar Agente sintético descartável' })).toBeVisible();
  await expect(page.getByText(/Se perder o segredo/)).toBeVisible();
  await page.getByLabel('Nome da credencial').fill('Exibição descartada na expiração');
  await page.getByRole('button', { name: 'Criar credencial', exact: true }).click();
  await expect(secret).toBeVisible();
  browser.expireNextRead('/api/v1/agent-credentials');
  await page.getByRole('button', { name: 'Reler credenciais', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
  await expect(secret).toHaveCount(0);
  expect((await api.request('/api/v1/health', { headers: agentHeaders })).status).toBe(200);
  await login(page); await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  await page.goto('/configuracoes'); await expect(secret).toHaveCount(0);
  await page.getByRole('button', { name: 'Revogar Agente sintético descartável' }).click();
  await expect(page.getByText('Revogada', { exact: false })).toBeVisible();
  expect((await api.request('/api/v1/health', { headers: agentHeaders })).status).toBe(401);
  await page.getByRole('button', { name: 'Revogar Exibição descartada na expiração', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revogar Exibição descartada na expiração', exact: true })).toHaveCount(0);
  await logout(page);
});

test('duas abas: saída explícita descarta rascunhos e recuperação usa callback nativo', async ({ page, context }) => {
  await syntheticBrowser(page, api, { contextRoutes: true });
  await page.goto('/vagas/nova');
  await page.getByLabel('Empresa', { exact: true }).fill('Rascunho que deve ser descartado');
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  await logout(second);
  await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
  await login(second); await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  await second.goto('/vagas/nova'); await expect(second.getByLabel('Empresa', { exact: true })).toHaveValue('');
  await page.reload(); await expect(page.getByLabel('Empresa', { exact: true })).toHaveValue('');
  await page.evaluate(() => localStorage.setItem('sb-127-auth-token-code-verifier', JSON.stringify('synthetic-verifier/recovery')));
  await page.goto('/recuperar-senha?code=synthetic-code');
  await expect(page.getByRole('heading', { name: 'Definir nova senha' })).toBeVisible();
  await page.getByLabel('Nova senha', { exact: true }).fill('synthetic-new-password');
  await second.bringToFront(); await page.bringToFront();
  await expect(page.getByLabel('Nova senha', { exact: true })).toHaveValue('synthetic-new-password');
  await page.getByRole('button', { name: 'Alterar senha', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  expect(page.url()).not.toContain('code=');
});

test('saída antiga durante alteração de senha não remove login mais novo em outra aba', async ({ page, context }) => {
  await syntheticBrowser(page, api, { contextRoutes: true });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('sb-127-auth-token-code-verifier', JSON.stringify('synthetic-verifier/recovery')));
  await page.goto('/recuperar-senha?code=synthetic-code');
  await expect(page.getByLabel('Nova senha', { exact: true })).toBeVisible();
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finished!: () => void; const settled = new Promise<void>(resolve => { finished = resolve; });
  await page.route('**/auth/v1/user', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    entered();
    try { await held; await route.fallback(); } finally { finished(); }
  });
  await page.getByLabel('Nova senha', { exact: true }).fill('synthetic-delayed-password');
  await page.getByRole('button', { name: 'Alterar senha', exact: true }).click();
  await started;
  try {
    await logout(second);
    await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
    await login(second);
    await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    await second.goto('/vagas/nova');
    await second.getByLabel('Empresa', { exact: true }).fill('Novo rascunho após saída anterior');
    const oldCleanup = page.waitForResponse(response => response.url().includes('/auth/v1/logout'));
    release(); await settled; await oldCleanup;
    await expect(second.getByLabel('Empresa', { exact: true })).toHaveValue('Novo rascunho após saída anterior');
    expect(await second.evaluate(() => localStorage.getItem('sb-127-auth-token') !== null)).toBe(true);
  } finally { release(); await settled; }
});

test('segunda saída intencional descarta B durante saída pendente de A e preserva C', async ({ page, context }) => {
  await syntheticBrowser(page, api, { contextRoutes: true, sessionIdentity: 'missing' });
  await page.goto('/'); const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let calls = 0; let originalRequest: Request | undefined;
  await page.route('**/auth/v1/logout*', async route => { if (++calls === 1) { originalRequest = route.request(); await held; } await route.fallback(); });
  const firstComplete = page.waitForResponse(response => response.request() === originalRequest);
  try {
    const otherFirst = second.waitForResponse(response => response.url().includes('/auth/v1/logout'));
    await logout(page); await otherFirst;
    await login(second); await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Registrar candidatura', exact: true }).click();
    await page.getByLabel('Empresa', { exact: true }).fill('Rascunho B descartável');
    const otherSecond = second.waitForResponse(response => response.url().includes('/auth/v1/logout'));
    await logout(page); await otherSecond;
    await expect(second.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
    await login(second); await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    await second.goto('/vagas/nova'); await second.getByLabel('Empresa', { exact: true }).fill('Rascunho C preservado');
    release(); await firstComplete;
    await expect(second.getByLabel('Empresa', { exact: true })).toHaveValue('Rascunho C preservado');
    await expect(page.getByLabel('Empresa', { exact: true })).toHaveValue('');
    await second.reload(); await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    expect(calls).toBe(2);
  } finally { release(); await firstComplete; }
});

test('recuperação PKCE automática pendente não retorna após saída em outra aba e novo link funciona', async ({ page, context }) => {
  await syntheticBrowser(page, api, { contextRoutes: true }); await page.goto('/');
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  let release!: () => void; let entered!: () => void; let finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; }); const settled = new Promise<void>(resolve => { finished = resolve; });
  let exchanges = 0;
  await page.route('**/auth/v1/token?grant_type=pkce', async route => {
    if (++exchanges !== 1) return route.fallback();
    entered(); try { await held; await route.fallback(); } finally { finished(); }
  });
  await page.evaluate(() => localStorage.setItem('sb-127-auth-token-code-verifier', JSON.stringify('synthetic-old-verifier/recovery')));
  await page.goto('/recuperar-senha?code=synthetic-old-code'); await started;
  try {
    const logoutComplete = second.waitForResponse(response => response.url().includes('/auth/v1/logout'));
    await logout(second); await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
    await second.evaluate(() => localStorage.setItem('sb-127-auth-token-code-verifier', JSON.stringify('synthetic-fresh-verifier/recovery')));
    release(); await settled; await logoutComplete;
    await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token') === null)).toBe(true);
    await page.goto('/'); await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token-code-verifier') === JSON.stringify('synthetic-fresh-verifier/recovery'))).toBe(true);
    await page.goto('/recuperar-senha?code=synthetic-fresh-code');
    await expect(page.getByRole('heading', { name: 'Definir nova senha', exact: true })).toBeVisible();
    await page.getByLabel('Nova senha', { exact: true }).fill('synthetic-current-password');
    await page.getByRole('button', { name: 'Alterar senha', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    expect(exchanges).toBe(2);
  } finally { release(); await settled; }
});

for (const identity of ['missing', 'malformed'] as const) {
  test(`saída mantém sessão rotacionada sem identidade válida bloqueada após recarregar: ${identity}`, async ({ page }) => {
    await syntheticBrowser(page, api, { sessionIdentity: identity }); await page.goto('/');
    await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const target = window as typeof window & { releaseSyntheticLock?: () => void };
      await new Promise<void>(entered => {
        void navigator.locks.request('lock:sb-127-auth-token', async () => {
          await new Promise<void>(release => { target.releaseSyntheticLock = release; entered(); });
        });
      });
      const stored = JSON.parse(localStorage.getItem('sb-127-auth-token')!);
      // Legacy rotated bytes deliberately lack the application's ownership marker.
      delete stored.careerTracker; stored.access_token += '-rotated'; stored.refresh_token += '-rotated';
      localStorage.setItem('sb-127-auth-token', JSON.stringify(stored));
    });
    const revoked = page.waitForResponse(response => response.url().includes('/auth/v1/logout'));
    try { await logout(page); }
    finally { await page.evaluate(() => { (window as typeof window & { releaseSyntheticLock?: () => void }).releaseSyntheticLock?.(); }); }
    await revoked; await page.reload();
    await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sb-127-auth-token')!).careerTracker.blocked)).toBe(true);
    await login(page); await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
  });
}
