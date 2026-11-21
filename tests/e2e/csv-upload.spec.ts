import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { syntheticBrowser } from '../helpers/synthetic-browser';
import { syntheticCareerApi } from '../helpers/synthetic-career';

test('importa o CSV legado de Vagas em uma conta vazia e recupera uma resposta perdida', async ({ page }) => {
  const api = await syntheticCareerApi();
  try {
    await page.setViewportSize({ width: 320, height: 825 });
    const browser = await syntheticBrowser(page, api);
    const buffer = await readFile(new URL('../fixtures/legacy.csv', import.meta.url));
    const upload = { name: 'fixture.csv', mimeType: 'text/csv', buffer };
    await page.goto('/vagas');
    const importer = page.getByRole('link', { name: 'Importar CSV' });
    await importer.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Importar candidaturas' })).toBeFocused();
    await expect(page.getByRole('link', { name: 'Vagas', exact: true })).toHaveAttribute('aria-current', 'page');
    const file = page.getByLabel('Arquivo CSV');
    const before = await api.auditCount();
    const previewButton = page.getByRole('button', { name: 'Conferir arquivo' });
    const forReview = Buffer.from(buffer.toString('utf8').replace('https://jobs.example.org/42', 'https://example.org/open jobs/42'));
    await file.setInputFiles({ ...upload, buffer: forReview });
    await previewButton.click();
    await expect(page.getByText('Um endereço web exige revisão.', { exact: false })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect(await api.auditCount()).toBe(before);

    await file.setInputFiles(upload);
    await previewButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Empresa, Exemplo')).toBeVisible();
    await expect(page.getByText(/Data desconhecida/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    const confirm = page.getByRole('button', { name: 'Importar 1 linha' });
    await expect(confirm).toBeDisabled();
    expect(await api.auditCount()).toBe(before);
    browser.loseNextSave('csv');
    const approval = page.getByRole('checkbox', { name: /conferi a prévia/i });
    await approval.focus();
    await page.keyboard.press('Space');
    await confirm.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/resultado ainda não confirmado/i)).toBeVisible();
    const afterCommit = await api.auditCount();
    expect(afterCommit).toBeGreaterThan(before);
    await page.getByRole('button', { name: 'Repetir confirmação' }).click();
    await expect(page.getByRole('heading', { name: 'Importação concluída' })).toBeVisible();
    expect(await api.auditCount()).toBe(afterCommit);
    const confirmations = browser.writes.filter(({ body }) => JSON.parse(body).unit === 'csv');
    expect(confirmations).toHaveLength(2);
    expect(confirmations[0]?.body).toBe(confirmations[1]?.body);
    expect(confirmations[0]?.key).toBeTruthy();
    expect(confirmations[0]?.key).toBe(confirmations[1]?.key);

    await page.getByRole('link', { name: 'Abrir lista de candidaturas' }).click();
    await expect(page.getByRole('link', { name: /Empresa, Exemplo/ })).toBeVisible();
    await page.getByRole('link', { name: 'Importar CSV' }).click();
    await file.setInputFiles(upload);
    await previewButton.click();
    await expect(page.getByText('Já importada', { exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect(await api.auditCount()).toBe(afterCommit);
  } finally { await api.close(); }
});
