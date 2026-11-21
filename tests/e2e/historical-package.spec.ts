import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_HEADER } from '../../domain/import';
import { createLegacyPreview } from '../../scripts/import-legacy';
import { unknownDate } from '../fixtures/career';
import { syntheticBrowser } from '../helpers/synthetic-browser';
import { syntheticCareerApi } from '../helpers/synthetic-career';

async function fixture(ownerId: string) {
  const directory = await mkdtemp(join(tmpdir(), 'invented-package-'));
  try {
    const sourceDir = join(directory, 'sources'), privateDir = join(directory, 'preparation');
    await mkdir(sourceDir); await mkdir(privateDir);
    const members = Array.from({length: 30}, (_, i) => ({legacyId: 'V' + (8001+i), capturedOrder: i+1}));
    const ids = [...members.map(m => m.legacyId), 'V8100'];
    const rows = ids.map((id,i) => [id,'Companhia fictícia '+i,'Analista','Portal','','','','','confirmado','','Relato','','Avaliação documentada',i<30 ? String(i+1) : '','Arquivo fictício','','']);
    const files = { 'controle.csv': [LEGACY_HEADER.join(','), ...rows.map(r => r.join(','))].join('\n'), 'revisao.md': '# Revisão inventada\n', 'notas.md': 'Anotação fictícia.', 'contexto.md': 'Contexto fictício.' };
    for (const [name, content] of Object.entries(files)) await writeFile(join(sourceDir,name),content);
    const preview = await createLegacyPreview({ sourceDir, privateDir, files: Object.keys(files) });
    const historicalEvent = { clientId: randomUUID(), kind: 'avaliacao', state: 'concluido', occurredDate: unknownDate, resultText: null, scoreValue: 7, scoreUnit: ' points ', sourceText: 'Avaliação documentada' };
    return { format: 'career-tracker-historical-import/1', operationId: randomUUID(), ownerId, sourceSetHash: preview.manifest.sourceSetHash, capturedAt: new Date().toISOString(),
      prepare: { manifest: preview.manifest, sources: Object.entries(files).map(([name,content]) => ({name,bytesBase64: Buffer.from(content).toString('base64')})), cycle: { id: randomUUID(), expectedVersion: null, resetDate: unknownDate, resetMarker: null, isCurrent: true }},
      applications: ids.map((legacyId,i) => ({legacyId,expectedVersion:null,expectedOpportunityVersion:null,decisions:null,affectedBatches:[], historicalEvents: i===30 ? [historicalEvent] : [],
        interpretation:{track:null,applicationInstance:'initial',cycleRelation:i===30?'before_reset':'after_reset',kind:'desconhecido',provider:null,tenant:null}})),
      review:{ batchNumber:1,members,markdownFile:'revisao.md',closedAt:null,historicalClosedDate:unknownDate,documentedUpdatedDate:unknownDate,snapshotTimeMeaning:'import_capture',snapshot:{schemaVersion:1,period:null,eventIds:[],metrics:{}},pendingIssues:['Data histórica desconhecida.'] },
      complete:{reviewRequired:true} };
  } finally { await rm(directory, { recursive: true, force:true }); }
}

test('o proprietário retoma o mesmo pacote e exporta a revisão com vínculos reais', async ({page}) => {
  test.setTimeout(180_000);
  const api = await syntheticCareerApi();
  try {
    const data = await fixture(api.owner);
    const browser = await syntheticBrowser(page,api);
    const file = page.getByLabel('Pacote histórico preparado (.json)');
    const send = async (value: unknown, whitespace = '') => file.setInputFiles({name:'inventado.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value)+whitespace)});
    const open = async () => { await page.goto('/vagas/importar'); await page.getByText('Importar pacote histórico',{exact:true}).click(); };
    const approve = async () => { await page.getByLabel('Conferi a prévia e autorizo a importação do histórico').check(); page.once('dialog',dialog=>dialog.accept()); await page.getByRole('button',{name:'Aplicar pacote histórico'}).click(); };
    await open();
    const before = await api.auditCount();
    await send({...data,ownerId:randomUUID()});
    await expect(page.getByRole('alert')).toContainText('conta de destino');
    const changed = structuredClone(data); changed.prepare.sources[0]!.bytesBase64=Buffer.from('alterada').toString('base64');
    await send(changed); await expect(page.getByRole('alert')).toContainText('Pacote inválido');
    await send(data); await expect(page.getByRole('button',{name:'Aplicar pacote histórico'})).toBeDisabled();
    expect(await api.auditCount()).toBe(before);
    browser.loseNextSave('application'); await approve();
    await expect(page.getByRole('alert')).toContainText('mesmo arquivo');
    await open(); await send(data,' '); await expect(page.getByRole('alert')).toContainText('divergiu');
    const generic = (unit: string, body: unknown) => api.request('/api/v1/imports/apply', {
      method: 'POST', headers: { ...api.headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ unit, data: body }),
    });
    const firstRun = JSON.parse(browser.writes.find(write => JSON.parse(write.body).unit === 'application')!.body).data.runId;
    const second = data.applications[1]!;
    expect((await generic('application', { ...second, runId: firstRun, interpretation: { ...second.interpretation, track: 'outra' } })).status).toBe(409);
    const interleaved: number[] = [];
    await page.route('**/api/v1/imports/apply', async route => {
      const command = route.request().postDataJSON();
      if (command.unit === 'review') {
        interleaved.push((await generic('complete', { runId: firstRun, reviewRequired: false })).status);
        interleaved.push((await generic('review', { ...command.data, pendingIssues: ['Revisão diferente'] })).status);
        interleaved.push((await generic('review', { ...command.data, snapshot: { ...command.data.snapshot, externalResultEventIds: [] } })).status);
      }
      await route.fallback();
    });
    await send(data);
    browser.loseNextSave('complete');
    await approve();
    await expect(page.getByRole('alert')).toContainText('mesmo arquivo', {timeout:120_000});
    expect(interleaved).toEqual([409,409,409]);
    const auditAfterCompletion = await api.auditCount();
    await open(); await send(data); await approve();
    expect(await api.auditCount()).toBe(auditAfterCompletion);
    await expect(page.getByText('Importação histórica concluída.',{exact:false})).toBeVisible({timeout:120_000});
    const writes=browser.writes.filter(w=>JSON.parse(w.body).unit==='application');
    expect(writes[0]?.key).toBeTruthy(); expect(writes[0]?.key).toBe(writes[1]?.key); expect(writes[0]?.body).toBe(writes[1]?.body);
    const download = page.waitForEvent('download');
    await page.getByRole('button',{name:'Baixar JSON completo'}).click();
    const snapshot = JSON.parse(await readFile((await (await download).path())!,'utf8')) as {entities:{table:string;data:Record<string,unknown>}[]};
    const table = (name:string) => snapshot.entities.filter(row=>row.table===name).map(row=>row.data);
    expect(table('applications')).toHaveLength(31); expect(table('review_versions')).toHaveLength(1);
    const outside=table('applications').find(a=>a.legacyId==='V8100')!;
    const event=table('events').find(e=>e.kind==='avaliacao')!;
    expect(event.applicationId).toBe(outside.id); expect(event.resultText).toBeNull(); expect(event.scoreUnit).toBe('points'); expect(event.scoreValue).toBe(7);
    expect(table('review_versions')[0]!.snapshot).toMatchObject({asOf:data.capturedAt,populationIds:data.review.members.map(m=>table('applications').find(a=>a.legacyId===m.legacyId)!.id),externalResultApplicationIds:[outside.id],externalResultEventIds:[event.id]});
  } finally { await api.close(); }
});

test('retomada preserva edição do proprietário e interrompe a revisão de versão divergente', async ({page}) => {
  test.setTimeout(180_000);
  const api = await syntheticCareerApi();
  try {
    const data = await fixture(api.owner);
    const bytes = Buffer.from(JSON.stringify(data));
    const apply = (unit: string, body: unknown, suffix: string) => api.request('/api/v1/imports/apply', {
      method: 'POST', headers: {...api.headers, 'content-type': 'application/json', 'idempotency-key': 'history:' + data.operationId + ':' + suffix},
      body: JSON.stringify({unit, data: body}),
    });
    const prepare = await apply('prepare', {format:'historical_package',bytesBase64:bytes.toString('base64')}, 'prepare');
    expect(prepare.status).toBe(200);
    const first = await apply('application', {...data.applications[0],runId:prepare.json.runId}, 'app:0');
    expect(first.status).toBe(200);
    const edited = await api.post({operation:'update_application', application:{id:first.json.applicationId,expectedVersion:first.json.version},changes:{notes:'Nota posterior da proprietária'},affectedBatches:[]});
    expect(edited.status).toBe(200);
    await syntheticBrowser(page,api);
    await page.goto('/vagas/importar');
    await page.getByText('Importar pacote histórico',{exact:true}).click();
    await page.getByLabel('Pacote histórico preparado (.json)').setInputFiles({name:'inventado.json',mimeType:'application/json',buffer:bytes});
    await page.getByLabel('Conferi a prévia e autorizo a importação do histórico').check();
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'Aplicar pacote histórico'}).click();
    await expect(page.getByRole('alert')).toContainText('divergiu',{timeout:120_000});
    const exported = await api.request('/api/v1/exports?format=json',{headers:api.headers});
    expect(exported.status).toBe(200);
    const entities = exported.json.entities as {table:string;data:Record<string,unknown>}[];
    expect(entities.find(row=>row.table==='applications' && row.data.id===first.json.applicationId)?.data.notes).toBe('Nota posterior da proprietária');
    expect(entities.some(row=>row.table==='review_versions')).toBe(false);
  } finally { await api.close(); }
});
