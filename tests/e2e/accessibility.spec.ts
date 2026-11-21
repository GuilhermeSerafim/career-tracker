import { test, expect } from '@playwright/test';
import axe from 'axe-core';
import { syntheticCareerApi } from '../helpers/synthetic-career';
import { syntheticBrowser } from '../helpers/synthetic-browser';
import { join } from 'node:path';
let api: Awaited<ReturnType<typeof syntheticCareerApi>>;
test.beforeEach(async () => { api = await syntheticCareerApi(); });
test.afterEach(async () => { await api?.close(); });
for (const width of [320, 375, 768, 1440]) test(`acessibilidade: ${width}px, teclado, árvore, contraste e texto ampliado`, async ({ page }, info) => {
  let externalRequests = 0;
  page.on('request', request => { if (!['http://127.0.0.1:4173', 'http://127.0.0.1:54321'].includes(new URL(request.url()).origin)) externalRequests++; });
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await syntheticBrowser(page, api);
  for (const route of ['/', '/vagas/nova', '/vagas/importar', '/analises', '/revisoes', '/configuracoes']) {
    await page.goto(route);
    await expect(page.getByRole('link', { name: 'Hoje', exact: true })).toBeVisible();
    await expect(page.locator('main h1')).toBeVisible();
    if (route === '/analises') await expect(page.getByRole('region', { name: 'Cobertura dos dados' })).toBeVisible();
    if (route === '/configuracoes') await expect(page.getByText('Nenhuma credencial nesta página.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(axe.source);
    const violations = await page.evaluate(async () => (await (window as typeof window & { axe: typeof axe }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })));
    expect(violations).toEqual([]);
    for (const control of await page.locator('button:visible, input:visible, select:visible').all()) {
      const box = await control.boundingBox(); expect(box!.height >= 44 && box!.width >= 44).toBe(true);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    await page.screenshot({ path: join(info.outputDir, `text-${route.replaceAll('/', '') || 'today'}-${width}.png`), fullPage: true });
    const reflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('main *')].filter(node => node.getBoundingClientRect().right > innerWidth && !node.closest('.analytics-table-region,.review-table')).slice(0, 8).map(node => ({ tag: node.tagName, class: node.className })) }));
    expect(reflow.scroll, JSON.stringify({ route, ...reflow })).toBeLessThanOrEqual(width);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  }
  await page.getByRole('button', { name: 'Conta', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Configurações', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Conta', exact: true })).toBeFocused();
  expect(await page.getByRole('button', { name: 'Conta', exact: true }).evaluate(node => parseFloat(getComputedStyle(node).outlineWidth) >= 3)).toBe(true);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(externalRequests).toBe(0);
});
