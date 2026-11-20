import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { syntheticCareerApi } from '../helpers/synthetic-career';
import { seedToday } from '../helpers/today-scenario';
import { connectTestDatabase } from '../helpers/database';
import { syntheticBrowser } from '../helpers/synthetic-browser';
import { seedReview } from '../helpers/review-scenario';

test.describe.configure({ mode: 'serial' });
let api: Awaited<ReturnType<typeof syntheticCareerApi>>;
let closeApi: (() => Promise<void>) | undefined;
test.beforeAll(async () => { api = await syntheticCareerApi(); closeApi = api.close; });
test.afterAll(async () => { const close = closeApi; closeApi = undefined; await close?.(); });


test('rotina Hoje: vazio, envios exatos, prazos, conversa e erro503 recuperável', async ({ page }, testInfo) => {
  const browser = await syntheticBrowser(page, api);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Meta de hoje' })).toContainText('0 de 5');
  await expect(page.getByText(/Registre sua primeira candidatura/)).toBeVisible();
  const scenario = await seedToday(api);
  await page.reload();
  const goal = page.getByRole('region', { name: 'Meta de hoje' });
  await expect(goal).toContainText('1 de 5');
  await expect(page.getByText(/2 candidaturas sem dia exato/)).toBeVisible();
  const actions = page.getByRole('region', { name: 'Próximas ações' });
  await expect(actions.locator('ol > li .today-task-link')).toHaveText(['Retomar conversa↗', 'Preparar entrevista↗', 'Revisar anotações↗', 'Organizar dúvidas↗', 'Retomar conversa independente+']);
  const history = page.getByRole('region', { name: 'Resultados de processos anteriores' });
  await expect(history).toContainText('Conversa anterior concluída.'); await expect(history).toContainText('Aconteceu em 02/10/2026'); await expect(history).toContainText('Registrado em');
  await expect(goal).not.toContainText('Entrevista');
  const artifacts = process.env.CAREER_E2E_ARTIFACT_DIR ?? testInfo.outputDir;
  await mkdir(artifacts, { recursive: true });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(goal).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    for (const control of await page.locator('.today-register, .today-task-link').all()) {
      const box = await control.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: join(artifacts, `task15-${width}.png`), fullPage: true });
  }
  const conversation = page.getByRole('button', { name: 'Retomar conversa independente' });
  await conversation.focus(); await page.keyboard.press('Enter');
  const detail = page.getByRole('region', { name: 'Detalhes da conversa' });
  await expect(detail).toContainText('Nome não informado'); await expect(detail).toContainText('Contato fictício sem nome informado.');
  await expect(detail.getByRole('link', { name: /Abrir conversa 1/ })).toHaveAttribute('href', 'https://example.test/conversa?token=fictional-only');
  expect(browser.apiReads.some((read) => read.path === `/api/v1/contacts/${scenario.contactId}` && read.status === 200)).toBe(true);
  await page.keyboard.press('Enter'); await expect(detail).toHaveCount(0);
  const task = actions.getByRole('link', { name: 'Retomar conversa' });
  await task.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/vagas/${scenario.applicationId}`);
  await expect(page.getByRole('heading', { name: 'Vagas', exact: true })).toBeFocused();
  const today = page.getByRole('link', { name: 'Hoje' }); await today.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Seu próximo passo.' })).toBeFocused();
  await expect(goal).toContainText('1 de 5');
  const auditBefore = await api.auditCount();
  browser.failToday(true); await page.reload();
  await expect(page.getByRole('alert')).toContainText('Não foi possível carregar sua rotina');
  await expect(goal).toHaveCount(0); expect(browser.apiReads.some((read) => read.path === '/api/v1/today' && read.status === 503)).toBe(true);
  expect(await api.auditCount()).toBe(auditBefore);
  browser.failToday(false);
  const retry = page.getByRole('button', { name: 'Tentar novamente' }); await retry.focus(); await page.keyboard.press('Enter');
  await expect(goal).toContainText('1 de 5'); await expect(page.getByRole('alert')).toHaveCount(0);
  const registration = page.getByRole('link', { name: /Registrar candidatura/ }); await registration.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/vagas/nova');
  expect(errors).toEqual([]);
});

test('cadastro e filtros: confirmação única, quadro, arquivo e leitura responsiva', async ({ page }, testInfo) => {
  const browser = await syntheticBrowser(page, api); const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/vagas/nova');
  await page.getByLabel('Empresa', { exact: true }).fill('Órbita Fictícia');
  await page.getByLabel('Cargo', { exact: true }).fill('Engenharia de IA');
  await page.getByLabel('Trilha', { exact: true }).fill('AI Builder');
  await page.getByLabel('Provedor da vaga').fill('Portal fictício');
  await page.getByLabel('Empresa no provedor (tenant)').fill('orbita');
  await page.getByLabel('Código da vaga').fill('AI-101');
  await page.getByLabel('Relato ou evidência', { exact: true }).fill('Eu enviei para esta trilha. Relato fictício.');
  browser.loseNextSave();
  await page.getByRole('button', { name: 'Registrar candidatura', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Serviço indisponível');
  const beforeRetry = await api.request('/api/v1/applications?view=confirmed&limit=100&filters=%7B%22archived%22%3A%22include%22%7D', { headers: api.headers });
  const total = beforeRetry.json.total;
  await page.getByRole('button', { name: 'Repetir gravação original' }).click();
  await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
  expect(browser.writes[1]!.key).toBe(browser.writes[0]!.key); expect(browser.writes[1]!.body).toBe(browser.writes[0]!.body);
  expect(browser.writes.map((w) => w.status)).toEqual([201, 201]);
  const listing = await api.request('/api/v1/applications?view=confirmed&limit=100&filters=%7B%22archived%22%3A%22include%22%7D', { headers: api.headers });
  expect(listing.json.total).toBe(total);
  const created = listing.json.items.find((a: { opportunity: { company: string } }) => a.opportunity.company === 'Órbita Fictícia');
  expect(created.submittedDate).toEqual({ precision: 'unknown', value: null }); expect(created.resumeIds).toEqual([]); expect(created.stage).toBe('desconhecida'); expect(created.cycleRelation).toBe('unknown'); expect(created.cycleOrder).toBeNull();
  await page.getByRole('link', { name: 'Voltar à lista', exact: true }).click();
  await page.getByText('Refinar filtros', { exact: true }).click();
  await page.getByLabel('Filtrar empresa', { exact: true }).fill('Órbita Fictícia');
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();
  await expect(page.getByText('1 registro(s) no filtro · 1 nesta página')).toBeVisible();
  await page.getByText('Refinar filtros', { exact: true }).click();
  const artifacts = process.env.CAREER_E2E_ARTIFACT_DIR ?? testInfo.outputDir; await mkdir(artifacts, { recursive: true });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: join(artifacts, `task16-list-${width}.png`), fullPage: true });
  }
  const boardButton = page.getByRole('button', { name: 'Quadro', exact: true }); await boardButton.focus(); await page.keyboard.press('Enter');
  const board = page.getByRole('region', { name: 'Quadro por etapa' });
  await board.getByLabel(`Etapa de ${created.displayId}`, { exact: true }).selectOption('entrevista');
  await board.getByRole('button', { name: `Mover ${created.displayId}` }).click();
  await expect(board.getByText('Etapa registrada.')).toBeVisible();
  const moved = await api.request(`/api/v1/applications/${created.id}`, { headers: api.headers });
  expect(moved.json.application.submissionStatus).toBe('confirmado'); expect(moved.json.events.filter((e: { kind: string }) => e.kind === 'envio_confirmado')).toHaveLength(1); expect(moved.json.events.filter((e: { kind: string; state: string }) => e.kind === 'entrevista' && e.state === 'concluido')).toHaveLength(0);
  expect(moved.json.events.find((e: { kind: string }) => e.kind === 'entrevista')).toMatchObject({ state: 'informado', occurredDate: { precision: 'unknown', value: null } });
  const task = await api.post({ operation: 'save_task', target: { clientId: crypto.randomUUID() }, parents: { application: { id: created.id, expectedVersion: moved.json.application.version }, contact: null }, data: { title: 'Ação fictícia preservada', dueDate: { precision: 'unknown', value: null } } }); expect(task.status).toBe(201);
  await board.getByRole('link', { name: 'Órbita Fictícia · Engenharia de IA' }).click();
  await page.getByRole('button', { name: 'Arquivar registro', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Impacto da decisão' })).toContainText('Histórico: 1 → 1');
  await page.getByRole('button', { name: 'Confirmar arquivamento' }).click();
  await expect(page.getByText('Decisão salva.')).toBeVisible();
  const archived = await api.request(`/api/v1/applications/${created.id}`, { headers: api.headers });
  expect(archived.json.application.archivedAt).not.toBeNull(); expect(archived.json.tasks[0].status).toBe('pending');
  const historic = await api.request('/api/v1/applications?view=confirmed&limit=100&filters=%7B%22archived%22%3A%22include%22%7D', { headers: api.headers }); expect(historic.json.total).toBe(total);
  await page.goto(`/vagas?ids=${encodeURIComponent(JSON.stringify([created.id]))}`);
  await expect(page.getByText('1 registro(s) no filtro · 1 nesta página')).toBeVisible(); await expect(page.getByRole('table')).toContainText('Arquivada');
  await page.goto('/'); await expect(page.getByRole('link', { name: 'Ação fictícia preservada' })).toBeVisible();
  await page.getByRole('link', { name: 'Ação fictícia preservada' }).click();
  await page.getByRole('button', { name: 'Restaurar registro' }).click(); await page.getByRole('button', { name: 'Confirmar arquivamento' }).click();
  await expect(page.getByText('Decisão salva.')).toBeVisible();
  expect((await api.request(`/api/v1/applications/${created.id}`, { headers: api.headers })).json.application.archivedAt).toBeNull();
  expect(errors).toEqual([]);
});

test('cadastro e filtros: currículo novo e conflito real da oportunidade compartilhada', async ({ page }, testInfo) => {
  await syntheticBrowser(page, api);
  const existing = (await api.request('/api/v1/applications?view=all&limit=100&filters=%7B%22archived%22%3A%22include%22%7D', { headers: api.headers })).json.items.find((a: { opportunity: { company: string } }) => a.opportunity.company === 'Órbita Fictícia');
  const sibling = await api.post({ operation: 'save_application', clientId: crypto.randomUUID(), data: { opportunity: { company: 'Órbita Fictícia', title: 'Engenharia de IA', platform: 'Portal fictício', tenant: 'orbita', jobCode: 'AI-101', jobKey: null, kind: 'vaga', seniority: null, modality: null, description: null, stack: [], identities: [] }, track: 'AI Engineer', applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: { precision: 'unknown', value: null }, stage: 'desconhecida', cycleRelation: 'unknown', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [], links: [] }, evidence: { clientId: crypto.randomUUID(), kind: 'relato_usuario', originalText: 'Outra trilha fictícia.', source: null, occurredDate: null, privateRef: null, localRef: null } });
  expect(sibling.status).toBe(201); expect(sibling.json.application.opportunity.id).toBe(existing.opportunity.id);
  await page.goto(`/vagas/${existing.id}`);
  await page.getByRole('link', { name: 'Editar registro', exact: true }).click();
  await page.getByRole('button', { name: 'Adicionar referência de currículo' }).click();
  await page.getByLabel('Nome do currículo').fill('CV IA fictício — novembro');
  await page.getByLabel('Idioma do currículo').fill('Português');
  await page.getByRole('button', { name: 'Criar referência', exact: true }).click();
  await expect(page.getByText('Referência criada: CV IA fictício — novembro')).toBeVisible();
  await page.getByRole('button', { name: 'Selecionar este currículo enviado' }).click();
  await expect(page.getByText('1 referência(s) selecionada(s).')).toBeVisible();
  await page.getByLabel('Senioridade', { exact: true }).fill('Pleno');
  await page.getByLabel('Observações', { exact: true }).fill('Minha anotação pendente');
  const concurrent = await api.post({ operation: 'update_application', application: { id: sibling.json.application.id, expectedVersion: sibling.json.application.version }, changes: {}, opportunityPatch: { opportunity: { id: existing.opportunity.id, expectedVersion: existing.opportunity.version }, changes: { seniority: 'Sênior' } } }); expect(concurrent.status).toBe(200);
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Conflito de edição' });
  await dialog.getByRole('button', { name: 'Reler versão atual' }).click();
  await expect(dialog.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Senioridade', exact: true }) })).toContainText('Sênior');
  await dialog.getByRole('checkbox', { name: 'Reaplicar Senioridade' }).check();
  await dialog.getByRole('checkbox', { name: 'Reaplicar Currículo enviado' }).check();
  await dialog.getByRole('button', { name: 'Reaplicar campos selecionados' }).click();
  await page.getByRole('button', { name: 'Salvar intenção revisada' }).click();
  await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
  const final = await api.request(`/api/v1/applications/${existing.id}`, { headers: api.headers });
  expect(final.json.application.opportunity.seniority).toBe('Pleno'); expect(final.json.application.notes).toBeNull(); expect(final.json.application.resumeIds).toHaveLength(1); expect(final.json.resumeRefs[0].label).toBe('CV IA fictício — novembro'); expect(final.json.application.submittedDate).toEqual({ precision: 'unknown', value: null });
  const artifacts = process.env.CAREER_E2E_ARTIFACT_DIR ?? testInfo.outputDir;
  for (const width of [375, 768, 1440]) { await page.setViewportSize({ width, height: 900 }); await page.getByRole('heading', { name: 'Vagas', exact: true }).focus(); await page.evaluate(() => window.scrollTo(0, 0)); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width); await page.screenshot({ path: join(artifacts, `task16-form-${width}.png`), fullPage: true }); }
});

test('cadastro e filtros: identidade existente, trilha distinta e paginação estável', async ({ page }) => {
  await syntheticBrowser(page, api);
  const fillIdentity = async (track: string) => {
    await page.getByLabel('Empresa', { exact: true }).fill('Órbita Fictícia'); await page.getByLabel('Cargo', { exact: true }).fill('Engenharia de IA');
    await page.getByLabel('Trilha', { exact: true }).fill(track); await page.getByLabel('Provedor da vaga').fill('Portal fictício');
    await page.getByLabel('Empresa no provedor (tenant)').fill('orbita'); await page.getByLabel('Código da vaga').fill('AI-101'); await page.getByLabel('Relato ou evidência', { exact: true }).fill('Relato fictício: a trilha foi conferida no comprovante.');
  };
  await page.goto('/vagas/nova'); await fillIdentity('AI Builder');
  const countBefore = (await api.request('/api/v1/applications?view=confirmed&limit=100', { headers: api.headers })).json.total;
  await page.getByRole('button', { name: 'Registrar candidatura', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Possíveis duplicatas' })).toContainText('mesma empresa e cargo');
  await page.getByRole('button', { name: 'Registrar como candidatura distinta com evidência' }).click();
  await expect(page.getByText(/A mesma identidade, trilha e ocorrência já estão registradas/)).toBeVisible();
  expect((await api.request('/api/v1/applications?view=confirmed&limit=100', { headers: api.headers })).json.total).toBe(countBefore);
  await page.getByRole('button', { name: 'Registrar outra candidatura' }).click(); await fillIdentity('Produto');
  await page.getByRole('button', { name: 'Registrar candidatura', exact: true }).click();
  await page.getByRole('button', { name: 'Registrar como candidatura distinta com evidência' }).click(); await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
  expect((await api.request('/api/v1/applications?view=confirmed&limit=100', { headers: api.headers })).json.total).toBe(countBefore + 1);
  for (let index = 0; index < 23; index++) {
    const status = index === 21 ? 'nao_enviado' : index === 22 ? 'nao_confirmado' : 'confirmado';
    const response = await api.post({ operation: 'save_application', clientId: crypto.randomUUID(), data: { opportunity: { company: 'Paginação fictícia', title: `Oportunidade ${index}`, platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'pipeline', seniority: null, modality: null, description: null, stack: ['TypeScript'], identities: [] }, track: null, applicationInstance: 'initial', submissionStatus: status, submittedDate: { precision: 'unknown', value: null }, stage: 'desconhecida', cycleRelation: 'unknown', discoveryChannel: 'Comunidade', submissionPlatform: 'Portal fictício', notes: null, resumeIds: [], links: [] }, evidence: status === 'confirmado' ? { clientId: crypto.randomUUID(), kind: 'relato_usuario', originalText: 'Envio fictício.', source: null, occurredDate: null, privateRef: null, localRef: null } : null }); expect(response.status).toBe(201);
  }
  await page.goto('/vagas'); await page.getByText('Refinar filtros', { exact: true }).click(); await page.getByLabel('Filtrar empresa', { exact: true }).fill('Paginação fictícia');
  await page.getByRole('button', { name: 'Aplicar filtros' }).click(); await expect(page.getByText('21 registro(s) no filtro · 20 nesta página')).toBeVisible();
  const firstPage = await page.getByRole('table').locator('tbody a').allTextContents();
  await page.getByRole('button', { name: 'Próxima página' }).click(); await expect(page.getByText('21 registro(s) no filtro · 1 nesta página')).toBeVisible();
  const secondPage = await page.getByRole('table').locator('tbody a').allTextContents(); expect(firstPage).not.toContain(secondPage[0]);
  await page.getByRole('button', { name: 'Página anterior' }).click(); await expect(page.getByText('21 registro(s) no filtro · 20 nesta página')).toBeVisible(); expect(await page.getByRole('table').locator('tbody a').allTextContents()).toEqual(firstPage);
  for (const view of ['saved', 'unknown']) { await page.getByLabel('Visualização', { exact: true }).selectOption(view); await page.getByRole('button', { name: 'Aplicar filtros' }).click(); await expect(page.getByText('1 registro(s) no filtro · 1 nesta página')).toBeVisible(); await expect(page.getByRole('table')).toContainText(view === 'saved' ? 'Oportunidade salva' : 'Envio desconhecido'); }
});

test('cadastro e filtros: data incompleta sobrevive ao login sem enviar valor anterior', async ({ page }) => {
  const browser = await syntheticBrowser(page, api);
  await page.goto('/vagas/nova'); await page.getByLabel('Empresa', { exact: true }).fill('Rascunho fictício');
  await page.getByLabel('Precisão', { exact: true }).selectOption('day'); await page.getByLabel('Certeza', { exact: true }).selectOption('exact');
  await page.getByLabel('Dia, mês e ano', { exact: true }).fill('2026-11-15'); await page.getByLabel('Dia, mês e ano', { exact: true }).fill('2026-11-');
  browser.expireNextList(); await page.getByRole('link', { name: 'Voltar para a lista', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
  await page.getByLabel('E-mail', { exact: true }).fill('synthetic@example.invalid'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password-only'); await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByRole('link', { name: 'Registrar candidatura', exact: false }).click();
  await expect(page.getByLabel('Empresa', { exact: true })).toHaveValue('Rascunho fictício'); await expect(page.getByLabel('Dia, mês e ano', { exact: true })).toHaveValue('2026-11-');
  await page.getByLabel('Cargo', { exact: true }).fill('Edição posterior'); await expect(page.getByLabel('Dia, mês e ano', { exact: true })).toHaveValue('2026-11-');
  await expect(page.getByRole('button', { name: 'Registrar candidatura', exact: true })).toBeDisabled();
  expect(browser.writes).toHaveLength(0);
});

test('cadastro e filtros: decisão explícita de duplicata e invalidação auditada', async ({ page }) => {
  await syntheticBrowser(page, api);
  const records = (await api.request('/api/v1/applications?view=confirmed&limit=100&filters=' + encodeURIComponent(JSON.stringify({ company: ['Paginação fictícia'] })), { headers: api.headers })).json.items;
  const source = records[0]; const target = records[1];
  await page.goto(`/vagas/${source.id}`); await page.getByRole('button', { name: 'Corrigir contagem ou duplicata' }).click();
  await page.getByLabel('Correção', { exact: true }).selectOption('resolve_duplicate'); await page.getByLabel('ID do registro canônico').fill(target.id);
  await page.getByLabel('Motivo da correção').fill('Dois registros fictícios do mesmo envio.'); await page.getByLabel('Evidência da correção').fill('Comprovantes fictícios comparados.');
  await page.getByRole('button', { name: 'Conferir impacto atual' }).click(); await expect(page.getByRole('region', { name: 'Impacto da decisão' })).toContainText('Histórico: 2 → 1');
  await page.getByRole('button', { name: 'Confirmar correção' }).click(); await expect(page.getByText('Decisão salva.')).toBeVisible();
  const merged = await api.request(`/api/v1/applications/${source.id}`, { headers: api.headers }); expect(merged.json.application.canonicalApplicationId).toBe(target.id);
  const canonical = await api.request(`/api/v1/applications/${target.id}`, { headers: api.headers }); expect(canonical.json.application.historyApplicationIds).toContain(source.id);
  await page.goto(`/vagas/${target.id}`); await page.getByRole('button', { name: 'Corrigir contagem ou duplicata' }).click();
  await page.getByLabel('Motivo da correção').fill('Confirmação fictícia registrada por engano.'); await page.getByLabel('Evidência da correção').fill('Não houve envio após conferência fictícia.');
  await page.getByRole('button', { name: 'Conferir impacto atual' }).click(); await expect(page.getByRole('region', { name: 'Impacto da decisão' })).toContainText('Histórico: 1 → 0');
  await page.getByRole('button', { name: 'Confirmar correção' }).click(); await expect(page.getByText('Decisão salva.')).toBeVisible();
  const invalidated = await api.request(`/api/v1/applications/${target.id}`, { headers: api.headers }); expect(invalidated.json.application.countingEligible).toBe(false); expect(invalidated.json.events.some((event: { kind: string }) => event.kind === 'correcao')).toBe(true);
  await page.goto(`/vagas/${records[2].id}`); await page.getByRole('button', { name: 'Corrigir contagem ou duplicata' }).click();
  await page.getByLabel('Correção', { exact: true }).selectOption('keep_distinct'); await page.getByLabel('Motivo da correção').fill('Ocorrência fictícia distinta.'); await page.getByLabel('Evidência da correção').fill('Comprovante próprio fictício.');
  await page.getByRole('button', { name: 'Conferir impacto atual' }).click(); await expect(page.getByRole('region', { name: 'Impacto da decisão' })).toContainText('Histórico: 1 → 1');
  await page.getByRole('button', { name: 'Confirmar correção' }).click(); await expect(page.getByText('Decisão salva.')).toBeVisible();
  const retained = await api.request(`/api/v1/applications/${records[2].id}`, { headers: api.headers }); expect(retained.json.application.countingEligible).toBe(true); expect(retained.json.application.canonicalApplicationId).toBeNull(); expect(retained.json.evidence.some((entry: { originalText: string }) => entry.originalText === 'Comprovante próprio fictício.')).toBe(true);
});

// Recovery cases need an owner without a started cycle; keep DB consumers serial.
test.describe('recovery on a fresh owner', () => {
  test.beforeAll(async () => {
    const close = closeApi; closeApi = undefined; await close?.();
    api = await syntheticCareerApi(); closeApi = api.close;
  });
test('recuperação de rascunho: rejeições reais400 e409 permitem correção explícita', async ({ page }) => {
  const browser = await syntheticBrowser(page, api);
  await page.goto('/vagas/nova');
  await page.getByLabel(/^Observações/).fill('Nota fictícia retida');
  await page.getByLabel(/^Relato ou evidência/).fill('Envio fictício relatado.');
  await page.getByLabel(/^Link original e alternativos/).fill('https://user:fictional@example.invalid');
  await page.getByRole('button', { name: 'Registrar candidatura', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revisar registro recusado' })).toBeVisible();
  expect(browser.writes[0]!.status).toBe(400);
  await page.getByRole('button', { name: 'Revisar registro recusado' }).click();
  await expect(page.getByLabel(/^Observações/)).toHaveValue('Nota fictícia retida');
  await page.getByLabel(/^Link original e alternativos/).fill('https://example.invalid');
  await page.getByRole('button', { name: 'Preparar intenção corrigida' }).click();
  expect(browser.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Salvar intenção revisada' }).click();
  await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
  expect(browser.writes[1]!.status).toBe(201); expect(browser.writes[1]!.key).not.toBe(browser.writes[0]!.key);
  await page.getByRole('button', { name: 'Registrar outra candidatura' }).click();
  await page.getByLabel(/^Relato ou evidência/).fill('Segundo envio fictício.');
  await page.getByLabel('Relação com o ciclo', { exact: true }).selectOption('after_reset');
  await page.getByRole('button', { name: 'Registrar candidatura', exact: true }).click();
  await expect(page.getByText(/O novo registro foi recusado/)).toBeVisible(); expect(browser.writes[2]!.status).toBe(409);
  await page.getByRole('button', { name: 'Revisar registro recusado' }).click();
  await expect(page.getByText(/O ciclo ainda não foi iniciado/)).toBeVisible();
  await expect(page.getByLabel('Relação com o ciclo', { exact: true })).toHaveValue('after_reset');
  await page.getByLabel('Relação com o ciclo', { exact: true }).selectOption('unknown');
  await page.getByRole('button', { name: 'Preparar intenção corrigida' }).click(); expect(browser.writes).toHaveLength(3);
  await page.getByRole('button', { name: 'Salvar intenção revisada' }).click();
  await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
  expect(browser.writes[3]!.status).toBe(201); expect(browser.writes[3]!.key).not.toBe(browser.writes[2]!.key);
  const records = await api.request('/api/v1/applications?view=all', { headers: api.headers });
  expect(records.json.total).toBe(2);
  const cycle = await api.request('/api/v1/batches?limit=1', { headers: api.headers }); expect(cycle.json.state).toBe('not_started');
});

test('recuperação de rascunho: atualização da decisão preserva edição e repetição incerta', async ({ page }) => {
  const browser = await syntheticBrowser(page, api);
  const records = await api.request('/api/v1/applications?view=all', { headers: api.headers });
  const original = records.json.items[0]; const id = original.id;
  const resume = await api.post({ operation: 'create_resume_ref', clientId: crypto.randomUUID(), data: { label: 'CV recuperação fictícia', stack: [], language: null, localRef: null } }); expect(resume.status).toBe(201);
  await page.goto(`/vagas/${id}`);
  await page.getByRole('link', { name: 'Editar registro', exact: true }).click();
  await page.getByLabel(/^Observações/).fill('Edição independente');
  await page.getByLabel('Precisão', { exact: true }).selectOption('day'); await page.getByLabel('Certeza', { exact: true }).selectOption('approximate');
  await page.getByLabel('Dia, mês e ano').fill('2026-11-');
  await page.getByLabel('Currículo efetivamente enviado').selectOption(resume.json.resumeRef.id);
  await page.getByRole('button', { name: 'Arquivar registro' }).click(); await page.getByRole('button', { name: 'Confirmar arquivamento' }).click();
  await expect(page.getByText(/Decisão salva/)).toBeVisible(); browser.failNextDetail();
  await page.getByRole('button', { name: 'Atualizar registro', exact: true }).click();
  await expect(page.getByText(/Não foi possível atualizar o registro salvo/)).toBeVisible();
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(page.getByLabel(/^Observações/)).toHaveValue('Edição independente');
    await expect(page.getByLabel('Dia, mês e ano')).toHaveValue('2026-11-');
    await expect(page.getByLabel('Currículo efetivamente enviado')).toHaveValues([resume.json.resumeRef.id]);
    if (!attempt) { await page.getByRole('button', { name: 'Atualizar registro', exact: true }).click(); await expect(page.getByRole('button', { name: 'Restaurar registro' })).toBeVisible(); }
  }
  let detail = await api.request(`/api/v1/applications/${id}`, { headers: api.headers });
  expect(detail.json.application.notes).toBe(original.notes); expect(detail.json.application.resumeIds).toEqual([]); expect(detail.json.application.submittedDate.precision).toBe('unknown');
  await page.getByLabel('Dia, mês e ano').fill('2026-11-16'); await page.getByLabel(/^Relato ou evidência/).fill('Data informada para o teste.');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  expect(browser.writes.at(-1)!.status).toBe(409); expect(JSON.parse(browser.writes.at(-1)!.body).application.expectedVersion).toBe(original.version);
  await dialog.getByRole('button', { name: 'Reler versão atual' }).click();
  for (const label of ['Observações', 'Data do envio', 'Currículo enviado', 'Relato ou evidência']) await dialog.getByRole('checkbox', { name: `Reaplicar ${label}`, exact: true }).check();
  await dialog.getByRole('button', { name: 'Reaplicar campos selecionados' }).click();
  browser.loseNextSave('update_application'); await page.getByRole('button', { name: 'Salvar intenção revisada' }).click();
  await expect(page.getByRole('button', { name: 'Repetir gravação original' })).toBeVisible(); const uncertain = browser.writes.at(-1)!;
  await page.getByRole('button', { name: 'Restaurar registro' }).click(); await page.getByRole('button', { name: 'Confirmar arquivamento' }).click();
  await expect(page.getByText(/Decisão salva/)).toBeVisible(); await page.getByRole('button', { name: 'Atualizar registro', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Arquivar registro' })).toBeVisible();
  await page.getByRole('button', { name: 'Repetir gravação original' }).click(); await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
  expect(browser.writes.at(-1)!.body).toBe(uncertain.body); expect(browser.writes.at(-1)!.key).toBe(uncertain.key);
  detail = await api.request(`/api/v1/applications/${id}`, { headers: api.headers });
  expect(detail.json.application.notes).toBe('Edição independente'); expect(detail.json.application.archivedAt).toBeNull(); expect(detail.json.application.resumeIds).toEqual([resume.json.resumeRef.id]);
});

});

async function historyApplication() {
  const resume = await api.post({ operation: 'create_resume_ref', clientId: crypto.randomUUID(), data: { label: 'CV histórico fictício', stack: ['TypeScript'], language: 'Português', localRef: 'C:/fictional/cv.pdf' } }); expect(resume.status).toBe(201);
  const saved = await api.post({ operation: 'save_application', clientId: crypto.randomUUID(), data: { opportunity: { company: 'Histórico Fictício', title: 'Engenharia de produto', platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'pipeline', seniority: null, modality: null, description: null, stack: [], identities: [] }, track: null, applicationInstance: 'initial', submissionStatus: 'nao_confirmado', submittedDate: { precision: 'unknown', value: null }, stage: 'desconhecida', cycleRelation: 'before_reset', discoveryChannel: 'Relato', submissionPlatform: null, notes: 'Processo histórico fictício.', resumeIds: [resume.json.resumeRef.id], links: [{ originalUrl: 'https://example.test/process?token=fictional', comparisonUrl: null, kind: 'original', isLocal: false, isPrivate: true }, { originalUrl: 'https://example.test/alternate', comparisonUrl: null, kind: 'alternativo', isLocal: false, isPrivate: true }] }, evidence: null }); expect(saved.status).toBe(201);
  return saved.json.application;
}

test('histórico e acompanhamento: correção auditada, avaliação sem novo envio, contato opcional e conclusão única', async ({ page }, testInfo) => {
  const browser = await syntheticBrowser(page, api); const application = await historyApplication(); const id = application.id;
  const confirmed = async () => (await api.request('/api/v1/applications?view=confirmed&limit=100', { headers: api.headers })).json.total;
  const before = await confirmed();
  const completed = await api.post({ operation: 'record_event', clientId: crypto.randomUUID(), application: { id, expectedVersion: application.version }, data: { kind: 'avaliacao', state: 'concluido', occurredDate: { precision: 'month', certainty: 'approximate', value: '2026-10' }, resultText: 'Conclusão anterior; resultado reaproveitado.', scoreValue: 79, scoreUnit: '%', sourceText: 'Relato fictício, sem verificação de portal.', evidence: { clientId: crypto.randomUUID(), kind: 'relato_usuario', originalText: '<img src=x onerror=alert(1)> Texto original fictício.', source: 'Anotação original', occurredDate: null, privateRef: null, localRef: 'C:/fictional/result.txt' } } }); expect(completed.status).toBe(201);
  await page.goto(`/vagas/${id}`);
  const history = page.getByRole('region', { name: 'Histórico do processo' });
  await expect(history).toContainText('outubro de 2026 (aproximado)'); await expect(history).toContainText('79 %'); await expect(history).toContainText('Registrado em');
  await expect(history.locator('img')).toHaveCount(0); await expect(history).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.getByRole('region', { name: 'Envio e etapa' })).toContainText('Envio desconhecido');
  await expect(page.getByRole('region', { name: 'Referências do registro' })).toContainText('CV histórico fictício');
  await expect(page.getByRole('link', { name: /original · referência/ })).toHaveAttribute('href', 'https://example.test/process?token=fictional');
  const activity = page.getByRole('region', { name: 'Registrar atividade' });
  await activity.getByLabel('Tipo de atividade', { exact: true }).selectOption('avaliacao'); await activity.getByLabel('Situação da atividade', { exact: true }).selectOption('convidado');
  await activity.getByLabel('Resultado ou relato').fill('Convite fictício a conferir.'); await activity.getByLabel('Origem do resultado').fill('Mensagem relatada');
  await activity.getByRole('button', { name: 'Salvar atividade' }).click(); await expect(activity.getByText('Registro salvo.', { exact: true })).toBeVisible();
  await activity.getByRole('button', { name: 'Atualizar histórico salvo' }).click();
  await expect(history).toContainText('Avaliação · Convite'); await expect(history).toContainText('Avaliação · Concluído');
  const invitation = history.locator('li').filter({ hasText: 'Convite fictício a conferir.' });
  await invitation.getByRole('button', { name: 'Corrigir interpretação deste evento' }).click();
  const correction = page.getByRole('region', { name: 'Corrigir interpretação', exact: true });
  await correction.getByLabel('Situação da atividade', { exact: true }).selectOption('informado'); await correction.getByLabel('Resultado ou relato').fill('Resultado anterior reaproveitado, sem novo convite.');
  await correction.getByLabel('Motivo da correção').fill('Reli o texto: era reaproveitamento.'); await correction.getByLabel('Evidência da atividade').fill('Texto fictício conferido pelo usuário.');
  const auditBefore = await api.auditCount(); await correction.getByRole('button', { name: 'Salvar correção' }).click();
  await expect(correction.getByText('Registro salvo.', { exact: true })).toBeVisible(); await correction.getByRole('button', { name: 'Atualizar histórico salvo' }).click();
  await expect(history).toContainText('Interpretação original substituída'); await expect(history).toContainText('Interpretação corrigida'); await expect(history).toContainText('Correção auditada');
  expect(await api.auditCount()).toBeGreaterThan(auditBefore); expect(await confirmed()).toBe(before);
  let detail = (await api.request(`/api/v1/applications/${id}`, { headers: api.headers })).json;
  expect(detail.application.stage).toBe('desconhecida'); expect(detail.application.submissionStatus).toBe('nao_confirmado'); expect(detail.events.some((event: { kind: string }) => event.kind === 'envio_confirmado')).toBe(false);
  const original = detail.events.find((event: { resultText: string }) => event.resultText === 'Convite fictício a conferir.'); expect(original.superseded).toBe(true); expect(detail.events.some((event: { supersedesEventId: string }) => event.supersedesEventId === original.id)).toBe(true);
  // A fresh tab/route read gives the next independent intention its explicit current basis.
  await page.reload();
  const contact = page.getByRole('region', { name: 'Criar contato opcional' });
  await contact.getByLabel('Notas do contato').fill('Contato fictício sem identidade presumida.'); await contact.getByLabel('Novos links do contato').fill('https://example.test/conversation?token=fictional-contact');
  await contact.getByRole('button', { name: 'Salvar contato' }).click(); await expect(contact.getByText('Registro salvo.', { exact: true })).toBeVisible();
  expect((await api.request(`/api/v1/applications/${id}`, { headers: api.headers })).json.contacts).toHaveLength(0);
  await page.reload();
  const catalog = page.getByRole('region', { name: 'Contatos opcionais' }); await expect(catalog).toContainText('Contato fictício sem identidade presumida.');
  const savedContact = (await api.request('/api/v1/contacts?limit=100', { headers: api.headers })).json.items.find((item: { notes: string }) => item.notes === 'Contato fictício sem identidade presumida.'); expect(savedContact.name).toBeNull();
  const task = page.getByRole('region', { name: 'Criar próxima ação' }); await task.getByLabel('Próxima ação', { exact: true }).fill('Conferir resultado histórico'); await task.getByLabel('Contato opcional', { exact: true }).selectOption(savedContact.id);
  await task.getByRole('button', { name: 'Salvar próxima ação' }).click(); await expect(task.getByText('Registro salvo.', { exact: true })).toBeVisible(); await task.getByRole('button', { name: 'Atualizar histórico salvo' }).click();
  const actions = page.getByRole('region', { name: 'Próximas ações do processo' }); await actions.getByText('Concluir ação', { exact: true }).click();
  const completion = page.getByRole('region', { name: 'Concluir: Conferir resultado histórico' });
  browser.loseNextSave('complete_task'); await completion.getByRole('button', { name: 'Confirmar conclusão' }).click(); await expect(completion.getByRole('button', { name: 'Repetir intenção original' })).toBeVisible(); const uncertain = browser.writes.at(-1)!;
  await completion.getByRole('button', { name: 'Repetir intenção original' }).click(); await expect(completion.getByText('Registro salvo.', { exact: true })).toBeVisible();
  expect(browser.writes.at(-1)!.body).toBe(uncertain.body); expect(browser.writes.at(-1)!.key).toBe(uncertain.key);
  await completion.getByRole('button', { name: 'Atualizar histórico salvo' }).click(); await expect(actions).toContainText('Concluída'); await expect(actions.getByText('Concluir ação', { exact: true })).toHaveCount(0);
  detail = (await api.request(`/api/v1/applications/${id}`, { headers: api.headers })).json;
  expect(detail.tasks).toHaveLength(1); expect(detail.tasks[0]).toMatchObject({ status: 'completed', version: 2, completedDate: { precision: 'unknown', value: null } }); expect(detail.contacts).toHaveLength(1); expect(await confirmed()).toBe(before);
  const artifacts = process.env.CAREER_E2E_ARTIFACT_DIR ?? testInfo.outputDir; await mkdir(artifacts, { recursive: true });
  for (const width of [375, 768, 1440]) { await page.setViewportSize({ width, height: 900 }); await page.getByRole('heading', { name: 'Vagas', exact: true }).focus(); await page.evaluate(() => window.scrollTo(0, 0)); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width); await page.screenshot({ path: join(artifacts, `task17-detail-${width}.png`), fullPage: true }); }
});

test('edição concorrente: duas abas preservam intenções e reaplicam somente o campo escolhido', async ({ page, context }) => {
  const application = await historyApplication(); const id = application.id; const browser = await syntheticBrowser(page, api);
  const second = await context.newPage(); await syntheticBrowser(second, api);
  try {
    await page.goto(`/vagas/${id}`); await page.getByRole('link', { name: 'Editar registro', exact: true }).click();
    await second.goto(`/vagas/${id}`); await second.getByRole('link', { name: 'Editar registro', exact: true }).click();
    await page.getByLabel(/^Observações/).fill('Intenção da aba A'); await page.getByLabel('Senioridade', { exact: true }).fill('Pleno');
    await second.getByLabel(/^Observações/).fill('Intenção da aba B'); await second.getByLabel('Modalidade', { exact: true }).fill('Remoto');
    await second.getByRole('button', { name: 'Salvar alterações' }).click(); await expect(second.getByText('Registro salvo.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Salvar alterações' }).click(); const dialog = page.getByRole('dialog', { name: 'Conflito de edição' }); await expect(dialog).toBeVisible();
    expect(browser.writes.at(-1)!.status).toBe(409); const refused = browser.writes.at(-1)!;
    await expect(dialog).toContainText('Intenção da aba A'); await dialog.getByRole('button', { name: 'Reler versão atual' }).click(); await expect(dialog).toContainText('Intenção da aba B');
    const afterRead = (await api.request(`/api/v1/applications/${id}`, { headers: api.headers })).json.application; expect(afterRead.notes).toBe('Intenção da aba B');
    await dialog.getByRole('checkbox', { name: 'Reaplicar Senioridade', exact: true }).check(); await dialog.getByRole('button', { name: 'Reaplicar campos selecionados' }).click();
    expect(browser.writes).toHaveLength(1); await page.getByRole('button', { name: 'Salvar intenção revisada' }).click(); await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
    const write = browser.writes.at(-1)!; expect(write.key).not.toBe(refused.key); expect(JSON.parse(write.body)).toMatchObject({ application: { id, expectedVersion: afterRead.version }, changes: {}, opportunityPatch: { opportunity: { id: afterRead.opportunity.id, expectedVersion: afterRead.opportunity.version }, changes: { seniority: 'Pleno' } } });
    const final = (await api.request(`/api/v1/applications/${id}`, { headers: api.headers })).json.application;
    expect(final.notes).toBe('Intenção da aba B'); expect(final.opportunity.modality).toBe('Remoto'); expect(final.opportunity.seniority).toBe('Pleno');
    await expect(second.getByLabel(/^Observações/)).toHaveValue('Intenção da aba B');
    await page.getByRole('link', { name: 'Ver histórico e acompanhamento', exact: true }).click(); await expect(page.getByRole('region', { name: 'Referências do registro' })).toContainText('Intenção da aba B');
  } finally { await second.close(); }
});

test('recuperação de alias: rascunho visível, navegação deliberada e resposta incerta recuperada pela chave original', async ({ page }) => {
  const browser = await syntheticBrowser(page, api);
  const merge = async (source: { id: string; version: number }, target: { id: string; version: number }) => {
    const result = await api.post({ operation: 'resolve_duplicate', application: { id: source.id, expectedVersion: source.version }, canonicalApplication: { id: target.id, expectedVersion: target.version }, affectedBatches: [], reason: 'Mesma ocorrência fictícia conferida.', evidence: { clientId: crypto.randomUUID(), kind: 'relato_usuario', originalText: 'União fictícia autorizada.', source: null, occurredDate: null, privateRef: null, localRef: null } }); expect(result.status).toBe(200);
  };
  const source = await historyApplication(); const target = await historyApplication();
  await page.goto(`/vagas/${source.id}`); await page.getByRole('link', { name: 'Editar registro', exact: true }).click();
  await page.getByLabel(/^Observações/).fill('Rascunho anterior à união');
  await merge(source, target);
  await page.getByRole('button', { name: 'Salvar alterações' }).click(); const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Reler versão atual' }).click(); const canonical = dialog.getByRole('link', { name: 'Abrir edição do registro canônico' });
  await expect(canonical).toHaveAttribute('href', `/vagas/${target.id}/editar`); await expect(dialog).toContainText('Rascunho anterior à união'); await expect(dialog.getByRole('button', { name: 'Reaplicar campos selecionados' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Fechar e manter edição' }).focus(); await page.keyboard.press('Tab'); await expect(canonical).toBeFocused();
  await dialog.getByRole('button', { name: 'Fechar e manter edição' }).click(); await expect(page.getByLabel(/^Observações/)).toHaveValue('Rascunho anterior à união'); await expect(page.getByLabel(/^Observações/)).toBeDisabled();
  await page.getByRole('link', { name: 'Abrir edição do registro canônico' }).click(); await expect(page.getByLabel(/^Observações/)).toHaveValue('Processo histórico fictício.'); expect(browser.writes).toHaveLength(1);
  await page.goBack(); await expect(page.getByLabel(/^Observações/)).toHaveValue('Rascunho anterior à união');

  const uncertainSource = await historyApplication(); const uncertainTarget = await historyApplication();
  await page.goto(`/vagas/${uncertainSource.id}`); const activity = page.getByRole('region', { name: 'Registrar atividade' });
  await activity.getByLabel('Resultado ou relato').fill('Atividade com resposta perdida antes da união'); browser.loseNextSave('record_event');
  await activity.getByRole('button', { name: 'Salvar atividade' }).click(); await expect(activity.getByRole('button', { name: 'Repetir intenção original' })).toBeVisible(); const uncertain = browser.writes.at(-1)!;
  const current = (await api.request(`/api/v1/applications/${uncertainSource.id}`, { headers: api.headers })).json.application;
  await merge(current, uncertainTarget); await page.getByRole('button', { name: 'Atualizar histórico', exact: true }).click(); await expect(page.getByRole('link', { name: 'Abrir registro canônico para acompanhar ou corrigir' })).toBeVisible();
  await expect(activity.getByLabel('Resultado ou relato')).toHaveValue('Atividade com resposta perdida antes da união'); await expect(activity.getByLabel('Resultado ou relato')).toBeDisabled();
  await activity.getByRole('button', { name: 'Repetir intenção original' }).click(); await expect(activity.getByText('Registro salvo.', { exact: true })).toBeVisible();
  expect(browser.writes.at(-1)!.body).toBe(uncertain.body); expect(browser.writes.at(-1)!.key).toBe(uncertain.key); expect(browser.writes.at(-1)!.status).toBe(201);
  const canonicalDetail = (await api.request(`/api/v1/applications/${uncertainTarget.id}`, { headers: api.headers })).json;
  const recovered = canonicalDetail.events.filter((event: { resultText: string }) => event.resultText === 'Atividade com resposta perdida antes da união'); expect(recovered).toHaveLength(1); expect(recovered[0].applicationId).toBe(uncertainSource.id);
});

test.describe('populações analíticas isoladas', () => {
  test.beforeEach(async () => {
    // Finish and audit the previous generated owner before opening this cohort.
    // Clearing the callback first also prevents double cleanup after a failed setup.
    const close = closeApi; closeApi = undefined; await close?.();
    api = await syntheticCareerApi(); closeApi = api.close;
  });

test('gráfico abre registros: barra e tabela preservam IDs, cobertura, paginação e chunks sob demanda', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const requested: string[] = []; page.on('request', (request) => { if (request.resourceType() === 'script') requested.push(new URL(request.url()).pathname); });
  await syntheticBrowser(page, api); await page.emulateMedia({ reducedMotion: 'reduce' });
  const ids: string[] = [];
  for (let index = 0; index < 27; index++) {
    const response = await api.post({ operation: 'save_application', clientId: crypto.randomUUID(), data: { opportunity: { company: `Análise fictícia ${index}`, title: 'Engenharia fictícia', kind: 'vaga', platform: null, tenant: null, jobCode: null, jobKey: null, seniority: null, modality: null, description: null, stack: ['React', '<img src=x onerror=alert(1)>'], identities: [] }, track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: index === 26 ? { precision: 'unknown', value: null } : { precision: 'day', certainty: 'exact', value: '2026-11-15' }, stage: 'desconhecida', cycleRelation: 'unknown', discoveryChannel: index < 25 ? 'Canal fictício' : index === 25 ? 'canal_desconhecido' : null, submissionPlatform: null, notes: null, resumeIds: [], links: [] }, evidence: { clientId: crypto.randomUUID(), kind: 'relato_usuario', originalText: 'Relato ficticio de envio confirmado.', source: null, occurredDate: null, privateRef: null, localRef: null } });
    expect(response.status).toBe(201); ids.push(response.json.application.id);
  }
  const returned = await api.post({ operation: 'record_event', clientId: crypto.randomUUID(), application: { id: ids[0], expectedVersion: 1 }, data: { kind: 'retorno_substantivo', state: 'informado', occurredDate: { precision: 'day', certainty: 'exact', value: '2026-11-16' }, resultText: 'Retorno inteiramente fictício.', scoreValue: null, scoreUnit: null, sourceText: null, evidence: null } });
  expect(returned.status).toBe(201);
  const undated = await api.post({ operation: 'record_event', clientId: crypto.randomUUID(), application: { id: ids[26], expectedVersion: 1 }, data: { kind: 'avaliacao', state: 'concluido', occurredDate: { precision: 'unknown', value: null }, resultText: 'Avaliação fictícia sem data.', scoreValue: null, scoreUnit: null, sourceText: null, evidence: null } });
  expect(undated.status).toBe(201);
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Seu próximo passo.' })).toBeVisible();
  expect(requested.some((path) => /Chart-|AnalyticsPage-/.test(path))).toBe(false);
  const analyticsResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/analytics' && response.status() === 200);
  await page.getByRole('link', { name: 'Análises', exact: true }).click(); await analyticsResponse;
  await page.getByRole('combobox', { name: 'Base de conversão' }).selectOption('all_dates');
  const normalizedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/analytics' && response.status() === 200);
  await page.getByRole('button', { name: 'Aplicar período' }).click();
  const result = await (await normalizedResponse).json();
  const channel = page.getByRole('region', { name: 'Canal de descoberta', exact: true });
  await expect(channel.getByRole('button', { name: 'Ver candidaturas: Canal fictício', exact: true })).toBeVisible();
  const graphic = channel.locator('.analytics-chart'); await expect(graphic.locator('svg')).toBeVisible();
  const groupIndex = result.groups.discoveryChannel.findIndex((group: { label: string }) => group.label === 'Canal fictício');
  expect(result.groups.discoveryChannel[groupIndex].applicationIds.slice().sort()).toEqual(ids.slice(0, 25).sort());
  const paths = graphic.locator('svg path[fill="#0131CD"]');
  // The visible decal overlays its blue bar. Click the observed bar's center so
  // the actual pointer hits the topmost pattern, as it does for a person.
  await paths.nth(groupIndex).scrollIntoViewIfNeeded();
  const barBox = await paths.nth(groupIndex).boundingBox(); expect(barBox).not.toBeNull();
  await page.mouse.click(barBox!.x + barBox!.width / 2, barBox!.y + barBox!.height / 2);
  await expect(page).toHaveURL(/\/vagas\?query=/);
  const barUrl = new URL(page.url());
  expect(JSON.parse(barUrl.searchParams.get('query')!)).toEqual(result.query);
  expect(JSON.parse(barUrl.searchParams.get('explain')!)).toEqual({ kind: 'group', collection: 'discoveryChannel', key: 'Canal fictício', isMissing: false });
  const listed = new Set<string>();
  for (let index = 0; index < 2; index++) {
    await expect(page.getByRole('status')).toContainText('25 registro(s)');
    for (const href of await page.locator('.application-table-region tbody a').evaluateAll((links) => links.map((link) => link.getAttribute('href')!))) listed.add(href.split('/').at(-1)!);
    if (index === 0) { await page.getByRole('button', { name: 'Próxima página' }).click(); await expect(page.getByText('Página 2', { exact: true })).toBeVisible(); }
  }
  expect([...listed].sort()).toEqual(ids.slice(0, 25).sort()); expect(listed.size).toBe(result.groups.discoveryChannel[groupIndex].count);
  await page.goBack(); await expect(channel).toBeVisible();
  const tableButton = channel.getByRole('button', { name: 'Ver candidaturas: Canal fictício', exact: true });
  await tableButton.focus(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(barUrl.href);
  await page.goBack();
  const missing = channel.getByRole('row', { name: /Canal desconhecido/ }); await expect(missing).toContainText('1');
  await missing.getByRole('button', { name: /^Ver candidaturas:/ }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('1 registro(s)');
  expect(JSON.parse(new URL(page.url()).searchParams.get('explain')!).isMissing).toBe(true);
  await expect(page.locator('.application-table-region tbody a')).toHaveAttribute('href', `/vagas/${ids[26]}`);
  await page.goBack(); await expect(channel).toBeVisible();
  await expect(page.getByRole('region', { name: 'Currículo efetivamente enviado', exact: true })).toContainText('Sem CV enviado informado');
  await expect(page.getByRole('region', { name: 'Cobertura dos dados' })).toContainText('Sem dia exato de envio');
  const occurrence = page.getByRole('region', { name: 'Data de ocorrência dos eventos' });
  const unknownOccurrence = occurrence.getByRole('row', { name: /^Data de ocorrência desconhecida/ });
  await expect(unknownOccurrence.getByRole('cell', { name: '2 / 29 eventos' })).toBeVisible();
  await unknownOccurrence.getByRole('button', { name: 'Ver candidaturas: Data de ocorrência desconhecida' }).click();
  await expect(page.locator('.application-table-region tbody a')).toHaveAttribute('href', `/vagas/${ids[26]}`);
  await page.goBack(); await expect(channel).toBeVisible();
  await expect(page.getByRole('region', { name: 'Stack informada', exact: true })).toContainText('<img src=x onerror=alert(1)>');
  expect(await page.locator('.analytics-content img').count()).toBe(0);
  const artifacts = process.env.CAREER_E2E_ARTIFACT_DIR ?? testInfo.outputDir; await mkdir(artifacts, { recursive: true });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const box = await channel.locator('.analytics-chart').boundingBox(); expect(box!.width).toBeGreaterThan(200);
    await expect.poll(async () => Number(await channel.locator('.analytics-chart svg').getAttribute('width'))).toBeCloseTo(box!.width, 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(artifacts, `task18-${width}.png`) });
    await channel.screenshot({ path: join(artifacts, `task18-channel-${width}.png`) });
  }
  const source = (await api.request(`/api/v1/applications/${ids[26]}`, { headers: api.headers })).json.application;
  const merged = await api.post({
    operation: 'resolve_duplicate', application: { id: source.id, expectedVersion: source.version },
    canonicalApplication: { id: ids[25], expectedVersion: 1 }, affectedBatches: [],
    reason: 'Integração fictícia de duplicata.', evidence: { clientId: crypto.randomUUID(), kind: 'relato_usuario', originalText: 'Identidade fictícia confirmada.', source: null, occurredDate: null, privateRef: null, localRef: null },
  });
  expect(merged.status).toBe(200);
  await unknownOccurrence.getByRole('button', { name: 'Ver candidaturas: Data de ocorrência desconhecida' }).click();
  await expect(page.getByRole('alert')).toContainText('A lista mudou desde o cálculo desta análise.');
  await expect(page.locator('.application-table-region')).toHaveCount(0);
  await page.getByRole('link', { name: 'Recalcular análise' }).click();
  await expect(unknownOccurrence.getByRole('cell', { name: '3 / 30 eventos' })).toBeVisible();
  await unknownOccurrence.getByRole('button', { name: 'Ver candidaturas: Data de ocorrência desconhecida' }).click();
  await expect(page.locator('.application-table-region tbody a')).toHaveAttribute('href', `/vagas/${ids[25]}`);
  expect(requested.some((path) => /Chart-/.test(path))).toBe(true); expect(errors).toEqual([]);
});

test('metadados das análises: CVs com mesmo rótulo, lote anterior e retry preservam IDs', async ({ page }, testInfo) => {
  await syntheticBrowser(page, api); await page.emulateMedia({ reducedMotion: 'reduce' });
  const resumeIds: string[] = []; const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const response = await api.post({ operation: 'create_resume_ref', clientId: crypto.randomUUID(), data: { label: 'Currículo React enviado', stack: ['React'], language: 'pt-BR', localRef: null } });
    expect(response.status).toBe(201); resumeIds.push(response.json.resumeRef.id);
    const saved = await api.post({ operation: 'save_application', clientId: crypto.randomUUID(), data: { opportunity: { company: `Metadados fictícios ${index}`, title: 'Engenharia fictícia', kind: 'vaga', platform: null, tenant: null, jobCode: null, jobKey: null, seniority: null, modality: null, description: null, stack: [], identities: [] }, track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: { precision: 'day', certainty: 'exact', value: '2026-11-15' }, stage: 'candidatura_enviada', cycleRelation: 'unknown', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [resumeIds[index]!], links: [] }, evidence: { clientId: crypto.randomUUID(), kind: 'relato_usuario', originalText: 'Relato fictício de envio confirmado.', source: null, occurredDate: null, privateRef: null, localRef: null } });
    expect(saved.status).toBe(201); ids.push(saved.json.application.id);
  }
  const oldBatch = crypto.randomUUID(); const oldCycle = crypto.randomUUID(); const currentCycle = crypto.randomUUID();
  const admin = await connectTestDatabase();
  try {
    await admin.query('INSERT INTO career.cycles(id,owner_id,is_current) VALUES($1,$2,false)', [oldCycle, api.owner]);
    if (!(await admin.query('SELECT id FROM career.cycles WHERE owner_id=$1 AND is_current', [api.owner])).rowCount) await admin.query('INSERT INTO career.cycles(id,owner_id,is_current) VALUES($1,$2,true)', [currentCycle, api.owner]);
    await admin.query('INSERT INTO career.batches(id,owner_id,cycle_id,batch_number) VALUES($1,$2,$3,7)', [oldBatch, api.owner, oldCycle]);
    await admin.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,1),($1,$2,$4,2)', [api.owner, oldBatch, ids[0], ids[1]]);
  } finally { await admin.end(); }
  const catalogue = await api.request('/api/v1/batches?limit=100', { headers: api.headers });
  expect(catalogue.status).toBe(200); expect(catalogue.json.items.some((batch: { id: string }) => batch.id === oldBatch)).toBe(false);
  let failMetadata = true;
  await page.route('**/api/v1/resume-refs?**', (route) => failMetadata ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.fallback());
  const analytics = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/analytics' && response.status() === 200);
  await page.goto('/analises'); const result = await (await analytics).json();
  await expect(page.getByText(/Não foi possível carregar todos os rótulos/)).toBeVisible();
  const cv = page.getByRole('region', { name: 'Currículo efetivamente enviado', exact: true });
  await expect(cv).toContainText(resumeIds[0]!); await expect(cv).toContainText('Metadados de CV indisponíveis');
  failMetadata = false; await page.getByRole('button', { name: 'Tentar novamente os rótulos' }).click();
  await expect(cv.getByRole('rowheader', { name: /Currículo React enviado/ })).toHaveCount(2);
  const batches = page.getByRole('region', { name: 'Evolução por lote', exact: true });
  await expect(batches).toContainText('Lote 7'); await expect(batches).toContainText(oldBatch);
  const cvIndex = result.groups.sentCv.findIndex((group: { key: string }) => group.key === resumeIds[0]);
  const cvPath = cv.locator('svg path[fill="#0131CD"]').nth(cvIndex);
  await cvPath.scrollIntoViewIfNeeded(); const box = await cvPath.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page).toHaveURL(/\/vagas\?query=/); const cvUrl = page.url();
  expect(JSON.parse(new URL(cvUrl).searchParams.get('explain')!)).toEqual({ kind: 'group', collection: 'sentCv', key: resumeIds[0], isMissing: false });
  await expect(page.getByRole('status')).toContainText('1 registro(s)');
  await expect(page.locator('.application-table-region tbody a')).toHaveAttribute('href', `/vagas/${ids[0]}`);
  await page.goBack();
  const button = cv.getByRole('button', { name: new RegExp(`^Ver candidaturas: .*ID: ${resumeIds[0]}$`) });
  await button.focus(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(cvUrl);
  await page.goBack();
  const second = cv.getByRole('button', { name: new RegExp(`^Ver candidaturas: .*ID: ${resumeIds[1]}$`) });
  await second.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('status')).toContainText('1 registro(s)');
  await expect(page.locator('.application-table-region tbody a')).toHaveAttribute('href', `/vagas/${ids[1]}`);
  await page.goBack();
  const batch = batches.getByRole('button', { name: new RegExp(`^Ver candidaturas: .*Lote 7.*ID: ${oldBatch}$`) });
  await batch.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('status')).toContainText('2 registro(s)');
  expect(JSON.parse(new URL(page.url()).searchParams.get('explain')!)).toEqual({ kind: 'group', collection: 'selectedGrouping', key: oldBatch, isMissing: false });
  expect((await page.locator('.application-table-region tbody a').evaluateAll((links) => links.map((link) => link.getAttribute('href')!.split('/').at(-1)!))).sort()).toEqual(ids.slice().sort());
  await page.goBack();
  const artifacts = process.env.CAREER_E2E_ARTIFACT_DIR ?? testInfo.outputDir; await mkdir(artifacts, { recursive: true });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await cv.screenshot({ path: join(artifacts, `task18-cv-${width}.png`) });
  }
});
});



// Measured setup reached 32.8s under host pressure; only this 29-member fixture gets 45s.
// The test continues on this same page/owner and creates the 30th member through UI.
const workflowTest = test.extend<{ workflow: { browser: Awaited<ReturnType<typeof syntheticBrowser>>; prepared: Awaited<ReturnType<typeof seedReview>> } }>({
  workflow: [async ({ page }, use) => {
    const started = performance.now();
    const browser = await syntheticBrowser(page, api, { seed: false });
    await page.goto('/revisoes');
    await page.getByLabel('E-mail', { exact: true }).fill('synthetic@example.invalid');
    await page.getByLabel('Senha', { exact: true }).fill('synthetic-password-only');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.getByLabel('Marco do ciclo (opcional)').fill('Ciclo fictício iniciado pelo proprietário');
    await page.getByRole('button', { name: 'Iniciar ciclo', exact: true }).click();
    await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
    const prepared = await seedReview(api, false, 29);
    expect(prepared).toHaveLength(29);
    console.log(JSON.stringify({ phase: 'workflow_setup', elapsedMs: Math.round(performance.now() - started) }));
    await use({ browser, prepared });
  }, { timeout: 45_000 }],
});

test.describe('revisões e transferências em proprietários isolados', () => {
  test.beforeEach(async () => {
    const close = closeApi; closeApi = undefined; await close?.();
    api = await syntheticCareerApi(); closeApi = api.close;
  });
  workflowTest('fechar e revisar lote: versões privadas, Markdown e meta na rotina', async ({ page, workflow }, testInfo) => {
    testInfo.setTimeout(60_000); // Complete measured cross-area interaction: 39.4s, excluding setup.
    const { browser, prepared } = workflow;
    const started = performance.now();
    await page.goto('/vagas/nova');
    await page.getByLabel('Empresa', { exact: true }).fill('Fluxo integrado fictício');
    await page.getByLabel('Cargo', { exact: true }).fill('Engenharia de software');
    await page.getByLabel('Relação com o ciclo', { exact: true }).selectOption('after_reset');
    await page.getByLabel('Relato ou evidência', { exact: true }).fill('Envio fictício confirmado pelo proprietário.');
    await page.getByRole('button', { name: 'Registrar candidatura', exact: true }).click();
    await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
    const saved = (await api.request('/api/v1/applications?view=confirmed&limit=100', { headers: api.headers })).json.items.find((item: { id: string }) => !prepared.some(member => member.id === item.id));
    expect(saved).toBeDefined();
    const repeated = await api.post({ operation: 'confirm_submission', application: { id: saved.id, expectedVersion: saved.version }, submittedDate: { precision: 'unknown', value: null }, cycleRelation: 'after_reset', evidence: { clientId: crypto.randomUUID(), kind: 'relato_usuario', originalText: 'Mesmo envio, confirmação repetida.', source: null, occurredDate: null, privateRef: null, localRef: null } });
    expect(repeated.status).toBe(200);
    expect((await api.request('/api/v1/applications?view=confirmed&limit=100', { headers: api.headers })).json.total).toBe(30);
    await page.getByRole('link', { name: 'Abrir registro salvo', exact: true }).click();
    const activity = page.getByRole('region', { name: 'Registrar atividade' });
    await activity.getByLabel('Tipo de atividade', { exact: true }).selectOption('avaliacao');
    await activity.getByLabel('Situação da atividade', { exact: true }).selectOption('concluido');
    await activity.getByLabel('Resultado ou relato').fill('Avaliação fictícia concluída.');
    await activity.getByRole('button', { name: 'Salvar atividade' }).click();
    await expect(activity.getByText('Registro salvo.', { exact: true })).toBeVisible();
    await activity.getByRole('button', { name: 'Atualizar histórico salvo' }).click();
    await page.reload(); // A separate intention starts from the newly saved parent version.
    const task = page.getByRole('region', { name: 'Criar próxima ação' });
    await task.getByLabel('Próxima ação', { exact: true }).fill('Conferir avaliação fictícia');
    await task.getByRole('button', { name: 'Salvar próxima ação' }).click();
    await expect(task.getByText('Registro salvo.', { exact: true })).toBeVisible();
    await task.getByRole('button', { name: 'Atualizar histórico salvo' }).click();
    await page.getByRole('region', { name: 'Próximas ações do processo' }).getByText('Concluir ação', { exact: true }).click();
    const completion = page.getByRole('region', { name: 'Concluir: Conferir avaliação fictícia' });
    await completion.getByRole('button', { name: 'Confirmar conclusão' }).click();
    await expect(completion.getByText('Registro salvo.', { exact: true })).toBeVisible();
    await page.goto('/vagas'); await page.getByText('Refinar filtros', { exact: true }).click();
    await page.getByLabel('Filtrar empresa', { exact: true }).fill('Fluxo integrado fictício');
    await page.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(page.getByText('1 registro(s) no filtro · 1 nesta página')).toBeVisible();
    await page.goto('/analises'); await page.getByRole('combobox', { name: 'Base de conversão' }).selectOption('all_dates');
    await page.getByRole('button', { name: 'Aplicar período' }).click();
    const channel = page.getByRole('region', { name: 'Canal de descoberta', exact: true });
    await channel.getByRole('button', { name: 'Ver candidaturas: Canal desconhecido', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('30 registro(s)');
    const apps = [saved, ...prepared];
    const visibleIds = await page.locator('.application-table-region tbody a').evaluateAll(links => links.map(link => link.getAttribute('href')!.split('/').at(-1)!));
    await page.getByRole('button', { name: 'Próxima página', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('10 nesta página');
    visibleIds.push(...await page.locator('.application-table-region tbody a').evaluateAll(links => links.map(link => link.getAttribute('href')!.split('/').at(-1)!)));
    expect(visibleIds.sort()).toEqual(apps.map(app => app.id).sort());
    console.log(JSON.stringify({ phase: 'workflow_chart', elapsedMs: Math.round(performance.now() - started) }));
    await page.goto('/revisoes');
    await page.reload(); await page.getByRole('link', { name: 'Lote 1 · Revisão pendente', exact: true }).click();
    const batchView = page.getByRole('region', { name: 'Lote 1', exact: true });
    const draftBasis = page.getByRole('region', { name: 'Base para confirmar este rascunho' });
    await expect(batchView.locator(':scope > p').getByText('30 elegíveis de 30', { exact: true })).toBeVisible();
    await expect(draftBasis.getByText('30 elegíveis de 30', { exact: true })).toBeVisible();
    expect(await batchView.locator(':scope > .review-population > li').count()).toBe(30);
    expect(await draftBasis.locator('.review-population li').count()).toBe(30);
    await page.getByLabel('Análise', { exact: true }).fill('Primeiro balanço fictício <script>sem execução</script>');
    await page.getByLabel('Próximos passos', { exact: true }).fill('Rever o currículo');
    await page.getByLabel('Conferi a população, o balanço e as lacunas').check();
    browser.loseNextSave('close_review'); await page.getByRole('button', { name: 'Confirmar fechamento' }).click();
    await page.getByRole('button', { name: 'Repetir intenção original' }).click();
    await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
    const closes = browser.writes.filter((write) => JSON.parse(write.body).operation === 'close_review');
    expect(closes).toHaveLength(2); expect(closes[1]!.body).toBe(closes[0]!.body); expect(closes[1]!.key).toBe(closes[0]!.key);
    await page.getByRole('button', { name: 'Atualizar dados salvos' }).click();
    await expect(page.getByRole('heading', { name: 'Versão 1 · Original' })).toBeVisible();
    const batchId = page.url().split('/').at(-1)!;
    const before = (await api.request(`/api/v1/batches/${batchId}`, { headers: api.headers })).json;
    const original = (await api.request(`/api/v1/reviews/${before.versions[0].id}`, { headers: api.headers })).json.version;
    const editor = page.getByRole('region', { name: 'Editar revisão' });
    console.log(JSON.stringify({ phase: 'workflow_closed', elapsedMs: Math.round(performance.now() - started), prepareVisible: await editor.getByRole('button', { name: 'Preparar nova revisão' }).isVisible() }));
    await editor.getByRole('button', { name: 'Preparar nova revisão' }).click();
    await expect(editor.getByRole('button', { name: 'Salvar nova versão privada' })).toBeVisible();
    await editor.getByRole('textbox', { name: 'Análise', exact: true }).fill('Análise revisada fictícia');
    await editor.getByLabel('Motivo', { exact: true }).fill('Esclarecer próximos passos');
    await editor.getByLabel('Relato ou evidência', { exact: true }).fill('Revisão informada pelo proprietário');
    await editor.getByLabel('Conferi a população, o balanço e as lacunas').check();
    await editor.getByRole('button', { name: 'Salvar nova versão privada' }).click();
    await editor.getByRole('button', { name: 'Atualizar dados salvos' }).click();
    await expect(page.getByRole('heading', { name: 'Versão 2 · Nova análise' })).toBeVisible();
    const after = (await api.request(`/api/v1/batches/${batchId}`, { headers: api.headers })).json;
    const revised = (await api.request(`/api/v1/reviews/${after.versions[1].id}`, { headers: api.headers })).json.version;
    expect(revised.predecessorId).toBe(original.id); expect(revised.snapshot).toEqual(original.snapshot);
    expect((await api.request(`/api/v1/reviews/${original.id}`, { headers: api.headers })).json.version).toEqual(original);
    await page.getByLabel('Versão selecionada').selectOption(original.id);
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar versão selecionada em Markdown' }).click();
    const download = await downloadPromise; const stream = await download.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); const markdown = Buffer.concat(chunks).toString('utf8');
    expect(markdown).toContain('Primeiro balanço fictício'); expect(markdown).not.toContain('Análise revisada fictícia'); expect(markdown).not.toContain('<script>'); for (const app of apps) expect(markdown).toContain(app.id);
    const artifacts = process.env.CAREER_E2E_ARTIFACT_DIR ?? testInfo.outputDir; await mkdir(artifacts, { recursive: true });
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const balance = page.getByRole('region', { name: 'Balanço da versão' }); await balance.focus(); await expect(balance).toBeFocused();
      if (width === 375) { expect(await balance.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true); await page.keyboard.press('ArrowRight'); await expect.poll(() => balance.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0); }
      await page.getByRole('heading', { name: 'Revisões', exact: true }).focus();
      await page.screenshot({ path: join(artifacts, `task19-review-${width}.png`), fullPage: true });
    }
    await page.goto('/configuracoes'); await page.getByLabel('Meta diária').fill('7'); await page.getByRole('button', { name: 'Salvar meta' }).click(); await expect(page.getByText('Registro salvo.', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Hoje', exact: true }).click(); await expect(page.getByRole('region', { name: 'Meta de hoje' })).toContainText('0 de 7');
    await page.getByRole('button', { name: 'Conta', exact: true }).click(); await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
    console.log(JSON.stringify({ phase: 'workflow_complete', elapsedMs: Math.round(performance.now() - started) }));
  });
  test('transferências privadas: bytes recebidos, confirmação explícita e prévia sem aplicar restauração', async ({ page }) => {
    await syntheticBrowser(page, api); await page.goto('/configuracoes');
    await expect(page.getByText('Nenhum arquivo salvo confirmado nesta sessão.')).toBeVisible();
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar JSON completo' }).click(); const download = await downloadPromise;
    const stream = await download.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); const snapshot = JSON.parse(bytes.toString('utf8'));
    expect(snapshot.manifest.tables).toHaveLength(20); await expect(page.getByText('Nenhum arquivo salvo confirmado nesta sessão.')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmo que salvei o arquivo em local privado' }).click(); await expect(page.getByText(/Último arquivo salvo confirmado por você nesta sessão/)).toBeVisible();
    const audits = await api.auditCount(); await page.getByLabel('Tipo de conferência').selectOption('restore');
    await page.getByLabel('Arquivo privado').setInputFiles({ name: 'snapshot-ficticio.json', mimeType: 'application/json', buffer: bytes });
    await expect(page.getByText('Estrutura conferida. O destino não foi verificado; restauração não aplicada.')).toBeVisible();
    await expect(page.locator('.review-report')).toContainText('structural_only'); await expect(page.locator('.review-report')).toContainText('not_performed');
    expect(await api.auditCount()).toBe(audits); await expect(page.getByRole('button', { name: /Aplicar.*restaura/ })).toHaveCount(0);
    await page.getByLabel('Arquivo privado').setInputFiles({ name: 'invalido.json', mimeType: 'application/json', buffer: Buffer.from('{"invalid":true}') }); await expect(page.getByRole('alert')).toContainText('Prévia recusada');
    expect(await api.auditCount()).toBe(audits);
  });
});
