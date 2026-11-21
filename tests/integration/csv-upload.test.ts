import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { LEGACY_HEADER } from '../../domain/import';
import { syntheticCareerApi } from '../helpers/synthetic-career';
import { unknownDate } from '../fixtures/career';

const fixture = await readFile(new URL('../fixtures/legacy.csv', import.meta.url), 'utf8');
const line = (id: string, company: string, title: string, order: string) =>
  [id, company, title, '', '', '', '', '', 'nao_enviado', '', '', '', '', order, '', '', ''].join(',');
const csv = (...rows: string[]) => [LEGACY_HEADER.join(','), ...rows, ''].join('\n');
const file = (text: string, fileName = 'vagas-ficticias.csv') => ({ fileName, bytesBase64: Buffer.from(text).toString('base64') });

it('previews without writes, preserves source and idempotently imports only new unambiguous rows', async () => {
  const api = await syntheticCareerApi();
  try {
    const post = (path: string, body: unknown, key = randomUUID(), authorization = api.headers.authorization) =>
      api.request('/api/v1/imports/' + path, { method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    const exportSnapshot = () => api.request('/api/v1/exports?format=json', { headers: api.headers });
    const preview = (upload: ReturnType<typeof file>) => post('preview', { format: 'csv_upload', ...upload });
    const apply = (upload: ReturnType<typeof file>, confirmation: string, key?: ReturnType<typeof randomUUID>) =>
      post('apply', { unit: 'csv', data: { ...upload, confirmation } }, key);
    const upload = file(fixture.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') +
      [line('V902', 'Empresa Gêmea', 'Dados', '2'), line('V903', 'Empresa Gêmea', 'Dados', '3'), ''].join('\r\n'));
    const before = await api.auditCount();
    const first = await preview(upload);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json).toMatchObject({ writes: false, totals: { rows: 3, eligible: 1, unchanged: 0, review: 2 } });
    expect(first.json.rows[0]).toMatchObject({ legacyId: 'V901', status: 'eligible', submittedDate: { precision: 'unknown', value: null } });
    expect(first.json.rows.slice(1).map((row: { status: string }) => row.status)).toEqual(['duplicate', 'duplicate']);
    expect(first.text).not.toContain('file:///privado');
    expect(await api.auditCount()).toBe(before);
    expect((await apply(upload, '1'.repeat(64))).status).toBe(409);
    expect(await api.auditCount()).toBe(before);
    expect((await post('preview', { format: 'csv_upload', ...upload }, randomUUID(), 'Bearer other.payload.signature')).status).toBe(403);

    const key = randomUUID();
    const applied = await apply(upload, first.json.confirmation, key);
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ imported: 1, unchanged: 0, review: 2 });
    expect((await apply(upload, first.json.confirmation, key)).json).toEqual(applied.json);
    expect((await apply(upload, first.json.confirmation)).status).toBe(409);
    const repeated = await preview(file(Buffer.from(upload.bytesBase64, 'base64').toString(), 'outra-copia.csv'));
    expect(repeated.json).toMatchObject({ confirmation: null, totals: { rows: 3, eligible: 0, unchanged: 1, review: 2 } });
    expect(await api.auditActors()).toContainEqual({ actor_kind: 'import', actor_id: api.owner });
    const snapshot = await exportSnapshot();
    expect(snapshot.status).toBe(200);
    const entities: { table: string; data: Record<string, unknown> }[] = snapshot.json.entities;
    expect(entities.filter(({ table }) => table === 'applications').map(({ data }) => data)).toEqual([
      expect.objectContaining({ legacyId: 'V901', displayId: 'V901', cycleRelation: 'unknown', cycleOrder: 1, submittedDate: { precision: 'unknown', value: null } }),
    ]);
    expect(entities.filter(({ table }) => table === 'source_files')[0]?.data)
      .toMatchObject({ fileName: upload.fileName, originalBytesBase64: upload.bytesBase64, originalText: Buffer.from(upload.bytesBase64, 'base64').toString() });
    expect(entities.filter(({ table }) => table === 'cycles' || table === 'batches' || table === 'review_versions')).toEqual([]);
    expect(entities.filter(({ table }) => table === 'evidence').map(({ data }) => data)).toEqual([
      expect.objectContaining({ kind: 'texto_legado', originalText: expect.stringContaining('Relato fictício') }),
    ]);
    expect(entities.filter(({ table }) => table === 'links').map(({ data }) => data.originalUrl)).toEqual(expect.arrayContaining(['file:///privado/a.pdf', 'https://jobs.example.org/42']));

    const changed = await preview(file(csv(line('V901', 'Outra Empresa', 'Backend', '1'), line('V904', 'Nova Empresa', 'Suporte', '1'))));
    expect(changed.json.blocked).toBe(true);
    expect(changed.json.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'duplicate_order', row: 3 })]));
    const crossFile = await preview(file(csv(line('V901', 'Outra Empresa', 'Backend', ''), line('V904', 'Nova Empresa', 'Suporte', '1'))));
    expect(crossFile.json.rows).toEqual([expect.objectContaining({ status: 'conflict' }), expect.objectContaining({ status: 'conflict' })]);
    expect(crossFile.json.confirmation).toBeNull();
    expect((await preview(file('id,empresa\nV1,Exemplo'))).json).toMatchObject({ blocked: true, confirmation: null });
    expect((await preview(file(csv(...Array.from({ length: 501 }, (_, index) => line('V' + (index + 1000), '', '', '')))))).json)
      .toMatchObject({ blocked: true, confirmation: null, issues: [{ code: 'row_limit' }] });
    expect((await preview(file(csv(line('V990', 'Exemplo', 'Cargo', '')), '../fixture.csv'))).status).toBe(400);
    expect((await post('apply', { unit: 'complete', data: { runId: applied.json.runId, reviewRequired: false } })).status).toBe(404);
  } finally {
    await api.close();
  }
});

function urlRow(id: string, original: string, alternatives = '', identity = { company: '', title: '' }) {
  return [id, identity.company, identity.title, '', '', '', original, alternatives, 'confirmado', '', 'Relato fictício', '', '', '', '', '', ''].join(',');
}

function importRequests(api: Awaited<ReturnType<typeof syntheticCareerApi>>) {
  const post = (path: string, body: unknown) => api.request('/api/v1/imports/' + path, {
    method: 'POST',
    headers: { ...api.headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  });
  return {
    preview: (upload: ReturnType<typeof file>) => post('preview', { format: 'csv_upload', ...upload }),
    apply: (upload: ReturnType<typeof file>, confirmation: string) => post('apply', { unit: 'csv', data: { ...upload, confirmation } }),
    snapshot: () => api.request('/api/v1/exports?format=json', { headers: api.headers }),
  };
}

it('previews only cycle orders with a representable successor and exports the exhausted counter', async () => {
  const api = await syntheticCareerApi();
  try {
    const { preview, apply, snapshot } = importRequests(api);
    const invalid = file(csv(line('V950', 'Exemplo', 'Dados', '9007199254740991')));
    const before = await api.auditCount();
    expect((await preview(invalid)).json).toMatchObject({
      blocked: true, confirmation: null, issues: [{ code: 'invalid_order', row: 2, column: 'ordem_ciclo' }],
    });
    expect(await api.auditCount()).toBe(before);
    const last = file(csv(line('V951', 'Exemplo', 'Dados', '9007199254740990')));
    const proposed = await preview(last);
    expect((await apply(last, proposed.json.confirmation)).json).toMatchObject({ imported: 1 });
    expect((await api.post({ operation: 'start_cycle', clientId: randomUUID(), resetDate: unknownDate, resetMarker: null })).status).toBe(201);
    const exported = await snapshot();
    expect(exported.status).toBe(200);
    expect(exported.json.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'applications', data: expect.objectContaining({ legacyId: 'V951', cycleOrder: 9007199254740990 }) }),
      expect.objectContaining({ table: 'cycles', data: expect.objectContaining({ nextOrder: 9007199254740991 }) }),
    ]));
  } finally { await api.close(); }
});

it('holds normalized URL matches for review within the file, preserving the full source with both variants', async () => {
  const api = await syntheticCareerApi();
  try {
    const { preview, apply, snapshot } = importRequests(api);
    const first = 'https://jobs.example.org/Open?utm_source=one&id=42#Job';
    const second = 'https://jobs.example.org/Open?id=42&utm_source=two#Job';
    const distinct = 'https://jobs.example.org/Open?id=43&utm_source=three#Job';
    const source = csv(urlRow('V915', first), urlRow('V916', '', second), urlRow('V917', distinct));
    const upload = file(source);
    const proposed = await preview(upload);
    expect(proposed.status).toBe(200);
    expect(proposed.json.rows.map((row: { status: string }) => row.status)).toEqual(['duplicate', 'duplicate', 'eligible']);
    expect((await apply(upload, proposed.json.confirmation)).json).toMatchObject({ imported: 1, review: 2 });
    const exported = await snapshot();
    expect(exported.status).toBe(200);
    expect(exported.json.entities).toContainEqual(expect.objectContaining({ table: 'source_files', data: expect.objectContaining({ originalText: source }) }));
    expect(exported.json.entities).toContainEqual(expect.objectContaining({ table: 'links', data: expect.objectContaining({ originalUrl: distinct }) }));
  } finally { await api.close(); }
});

it('finds normalized matches against existing native and legacy links', async () => {
  const api = await syntheticCareerApi();
  try {
    const { preview, apply, snapshot } = importRequests(api);
    const native = 'https://jobs.example.org/Open?utm_source=source&id=84#Keep';
    const legacy = 'https://jobs.example.org/Open?utm_source=source&id=85#Keep';
    const original = file(csv(urlRow('V918', legacy)));
    const proposed = await preview(original);
    expect((await apply(original, proposed.json.confirmation)).status).toBe(200);
    const saved = await api.post({
      operation: 'save_application', clientId: randomUUID(), evidence: null,
      data: {
        opportunity: { company: 'Organização fictícia', title: 'Emprego de teste', platform: null, tenant: null, jobCode: null, jobKey: null, kind: 'vaga', seniority: null, modality: null, description: null, stack: [], identities: [] },
        track: null, applicationInstance: 'initial', submissionStatus: 'nao_enviado', submittedDate: unknownDate, stage: 'desconhecida',
        cycleRelation: 'unknown', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [],
        links: [{ originalUrl: native, comparisonUrl: null, kind: 'vaga', isLocal: false, isPrivate: false }],
      },
    });
    expect(saved.status).toBe(201);
    const exported = await snapshot();
    expect(exported.json.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'links', data: expect.objectContaining({ originalUrl: legacy, comparisonUrl: null }) }),
      expect.objectContaining({ table: 'links', data: expect.objectContaining({ originalUrl: native, comparisonUrl: 'https://jobs.example.org/Open?id=84#Keep' }) }),
    ]));
    const compared = await preview(file(csv(
      urlRow('V919', 'https://jobs.example.org/Open?id=84&gh_src=other#Keep'),
      urlRow('V920', 'https://jobs.example.org/Open?id=85&jobBoardSource=other#Keep'),
      urlRow('V921', 'https://jobs.example.org/Open?id=85&jobBoardSource=other#Different'),
    )));
    expect(compared.status).toBe(200);
    expect(compared.json.rows.map((row: { status: string }) => row.status)).toEqual(['duplicate', 'duplicate', 'eligible']);
  } finally { await api.close(); }
});

it('holds malformed legacy web URLs for review during the first upload and later attempts', async () => {
  const api = await syntheticCareerApi();
  try {
    const { preview, apply, snapshot } = importRequests(api);
    const raw = 'https://example.org/open jobs/42';
    const first = urlRow('V924', raw, '', { company: 'Equipe Alfa fictícia', title: 'Dados' });
    const second = urlRow('V925', '', raw, { company: 'Equipe Beta fictícia', title: 'Pesquisa' });
    const before = await api.auditCount();
    const both = await preview(file(csv(first, second)));
    expect(both.status).toBe(200);
    const forReview = { status: 'blocked', issues: expect.arrayContaining(['legacy_url_review']) };
    expect(both.json).toMatchObject({ confirmation: null, totals: { eligible: 0, review: 2 }, rows: [forReview, forReview] });
    expect(await api.auditCount()).toBe(before);

    const source = csv(first, second, urlRow('V926', 'https://example.org/another-job'));
    const upload = file(source);
    const mixed = await preview(upload);
    expect(mixed.json).toMatchObject({ totals: { eligible: 1, review: 2 }, rows: [forReview, forReview, { status: 'eligible' }] });
    expect(await api.auditCount()).toBe(before);
    const applied = await apply(upload, mixed.json.confirmation);
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ imported: 1, review: 2 });
    const exported = await snapshot();
    expect(exported.status).toBe(200);
    const entities: { table: string; data: Record<string, unknown> }[] = exported.json.entities;
    expect(entities.filter(({ table }) => table === 'applications').map(({ data }) => data.legacyId)).toEqual(['V926']);
    expect(entities.filter(({ table }) => table === 'source_files')[0]?.data.originalText).toBe(source);
    const later = await preview(file(csv(urlRow('V927', raw))));
    expect(later.json).toMatchObject({ confirmation: null, rows: [forReview] });
  } finally { await api.close(); }
});

it('projects repeated references once per exact text and retains the complete original in evidence', async () => {
  const api = await syntheticCareerApi();
  try {
    const { preview, apply, snapshot } = importRequests(api);
    const original = 'https://e.test';
    const variant = original + '?utm_source=other';
    const row = urlRow('V922', original, [...Array<string>(2000).fill(original), variant].join(' | '));
    const tooMany = await preview(file(csv(urlRow('V923', '', Array.from({ length: 51 }, (_, i) => original + '/' + i).join(' | ')))));
    expect(tooMany.json.rows).toMatchObject([{ status: 'blocked', issues: expect.arrayContaining(['projection_limits']) }]);
    const upload = file(csv(row));
    const proposed = await preview(upload);
    expect(proposed.status).toBe(200);
    expect(proposed.json.rows).toMatchObject([{ status: 'eligible' }]);
    expect((await apply(upload, proposed.json.confirmation)).status).toBe(200);
    const exported = await snapshot();
    const entities: { table: string; data: Record<string, unknown> }[] = exported.json.entities;
    expect(entities.filter(({ table }) => table === 'links').map(({ data }) => data.originalUrl).sort()).toEqual([original, variant]);
    expect(entities.filter(({ table }) => table === 'evidence')[0]?.data.originalText).toBe(row + '\n');
  } finally { await api.close(); }
});
