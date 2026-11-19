import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { getTransformedRoutes, isHandler } from '@vercel/routing-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, startHandler } from '../helpers/api';
import { createApp } from '../../server/app';
import { authenticateBearer } from '../../server/auth';
import { createDatabase } from '../../server/database';
import { readServerConfig } from '../../server/config';
import { provisionOwner } from '../../scripts/provision-owner';
import { connectTestDatabase } from '../helpers/database';
import { unknownDate } from '../fixtures/career';
import { buildSnapshot, validateSnapshot } from '../../domain/export';
import {
  LEGACY_HEADER,
  IMPORTER_VERSION,
  PARSER_VERSION,
  parseLegacyCsv,
  sha256,
} from '../../domain/import';
import { SafeError } from '../../server/errors';
import { createRuntimeApp } from '../../server/runtime';
import vercelConfig from '../../vercel.json';

const owner = randomUUID();
const human = { authorization: 'Bearer eyJhIjox.eyJiIjoy.signature' };
const evidence = () => ({
  clientId: randomUUID(),
  kind: 'relato_usuario',
  originalText: 'Relato fictício.',
  source: null,
  occurredDate: unknownDate,
  privateRef: null,
  localRef: null,
});
const save = () => ({
  operation: 'save_application',
  clientId: randomUUID(),
  data: {
    opportunity: {
      company: 'Empresa fictícia',
      title: 'Engenharia',
      platform: null,
      tenant: null,
      jobCode: null,
      jobKey: null,
      kind: 'vaga',
      seniority: null,
      modality: null,
      description: null,
      stack: [],
      identities: [],
    },
    track: null,
    applicationInstance: 'initial',
    submissionStatus: 'confirmado',
    submittedDate: unknownDate,
    stage: 'desconhecida',
    cycleRelation: 'unknown',
    discoveryChannel: null,
    submissionPlatform: null,
    notes: null,
    resumeIds: [],
    links: [],
  },
  evidence: evidence(),
});
let admin: pg.Client;
let database: ReturnType<typeof createDatabase>;
let api: Awaited<ReturnType<typeof startApi>>;
let authenticate: Parameters<typeof startApi>[0]['authenticate'];
const post = (command: unknown, key = randomUUID()) =>
  api.request('/api/v1/commands', {
    method: 'POST',
    headers: { ...human, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(command),
  });
const transferPost = (path: string, body: unknown, key = randomUUID(), target = api) =>
  target.request('/api/v1/' + path, {
    method: 'POST',
    headers: { ...human, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
function sourceUpload(count = 1, base = 9701, markdownSize = 220000, exactMarkdown?: string) {
  const row = [
    'V9701',
    'Empresa sintética',
    'Cargo',
    'portal',
    '',
    '',
    'https://example.test/original?token=fictional',
    '',
    'confirmado',
    '',
    'Relato',
    'CV antigo',
    'Narrativa',
    '',
    'fonte',
    'nota',
    '2020-02-03',
  ];
  const rows = Array.from({ length: count }, (_, index) => {
    const copy = [...row];
    copy[0] = 'V' + (base + index);
    copy[13] = count > 1 ? String(index + 1) : '';
    return copy;
  });
  const bytes = Buffer.from(
    LEGACY_HEADER.join(',') +
      '\r\n' +
      rows
        .map((values) => values.map((v) => '"' + v.replaceAll('"', '""') + '"').join(','))
        .join('\r\n') +
      '\r\n',
  );
  const parsed = parseLegacyCsv(bytes);
  const time = '2026-11-16T12:00:00Z';
  const files = [
    { name: 'controle.csv', bytes },
    {
      name: 'revisao.md',
      bytes: Buffer.from(
        exactMarkdown ?? '\ufeff# História sintética\n' + 'x'.repeat(markdownSize),
      ),
    },
  ];
  const sources = files.map((file) => ({
    name: file.name,
    sourcePath: 'ignored/' + file.name,
    snapshotPath: 'sources/' + file.name,
    sha256: sha256(file.bytes),
    size: file.bytes.length,
    ids: file.name.endsWith('.csv') ? rows.map((value) => value[0]!) : [],
    rowCount: file.name.endsWith('.csv') ? count : 0,
    readAt: time,
  }));
  return {
    manifest: {
      formatVersion: 2,
      mode: 'preview',
      importerVersion: IMPORTER_VERSION,
      parserVersion: PARSER_VERSION,
      sourceSetHash: sha256(
        JSON.stringify({
          importer: IMPORTER_VERSION,
          parser: PARSER_VERSION,
          sources: sources.map(({ name, sha256: hash }) => ({ name, sha256: hash })),
        }),
      ),
      startedAt: time,
      completedAt: time,
      snapshotDirectory: 'ignored',
      writerFreeze: false,
      requiresSourceRecheckBeforeApply: true,
      sources,
      parsed,
      comparison: { mode: 'source_only', basis: [] },
      diff: rows.map((values) => ({ legacyId: values[0]!, kind: 'new' })),
    },
    sources: files.map((file) => ({ name: file.name, bytesBase64: file.bytes.toString('base64') })),
    cycle: {
      id: randomUUID(),
      expectedVersion: null as number | null,
      resetDate: unknownDate,
      resetMarker: null,
      isCurrent: true,
    },
  };
}
function privateResponse(response: Awaited<ReturnType<typeof api.request>>) {
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers.vary).toBe('Authorization');
  expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
}
beforeAll(async () => {
  admin = await connectTestDatabase();
  const password = randomBytes(32).toString('base64url');
  await provisionOwner({
    adminUrl: process.env.LOCAL_TEST_DATABASE_URL,
    ownerId: owner,
    apiPassword: password,
    restorePassword: randomBytes(32).toString('base64url'),
  });
  const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!);
  url.username = 'career_api';
  url.password = password;
  const config = readServerConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url.href,
    DATABASE_TLS: 'disable-local',
    OWNER_USER_ID: owner,
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  });
  database = createDatabase(config);
  authenticate = (header) =>
    authenticateBearer(header, config, {
      getUser: async (token) =>
        token.startsWith('down.')
          ? Promise.reject(Error('private'))
          : {
              data: { user: { id: token.startsWith('other.') ? randomUUID() : owner } },
              error: null,
            },
    });
  api = await startApi({ database, authenticate, logger: () => undefined });
});
afterAll(async () => {
  await api?.close();
  await database?.close();
  if (admin) {
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    for (const table of [
      'mutation_keys',
      'creation_requests',
      'review_versions',
      'batch_members',
      'batches',
      'import_rows',
      'source_files',
      'import_runs',
      'cycles',
      'application_resumes',
      'links',
      'events',
      'tasks',
      'contacts',
      'evidence',
      'resume_refs',
      'applications',
      'opportunity_identities',
      'opportunities',
      'owner_settings',
      'audit_log',
      'maintenance_state',
      'owner_config',
    ])
      await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await admin.query('COMMIT');
    await admin.end();
  }
});
describe('rewrites hospedados', () => {
  const { routes, error } = getTransformedRoutes(vercelConfig);
  let hostedApi: Awaited<ReturnType<typeof startHandler>>;

  function rewrite(pathname: string) {
    for (const route of routes ?? []) {
      if (isHandler(route) || !route.dest) continue;
      const pattern = new RegExp(route.src);
      if (pattern.test(pathname))
        return new URL(pathname.replace(pattern, route.dest), 'http://localhost');
    }
  }

  beforeAll(async () => {
    expect(error).toBeNull();
    const app = createApp({ database, authenticate, logger: () => undefined });
    hostedApi = await startHandler((request, response) => {
      const original = new URL(request.url ?? '/', 'http://localhost');
      const destination = rewrite(original.pathname);
      if (destination?.pathname !== '/api/index') {
        response.writeHead(404).end();
        return;
      }
      // A função interna recebe o caminho original e a query resultante do rewrite.
      for (const [key, value] of destination.searchParams) {
        if (!original.searchParams.has(key)) original.searchParams.append(key, value);
      }
      request.url = original.pathname + original.search;
      void app(request, response);
    });
  });
  afterAll(async () => { await hostedApi?.close(); });

  it('encaminha somente o namespace da API à função', () => {
    expect(rewrite('/api')?.pathname).toBe('/api/index');
    expect(rewrite('/api/v1/imports/preview')?.pathname).toBe('/api/index');
    expect(rewrite('/apiary')?.pathname).toBe('/index.html');
    expect(rewrite('/applications/exemplo')?.pathname).toBe('/index.html');
  });

  it('encaminha leituras autenticadas sem parâmetro de roteamento', async () => {
    for (const path of ['/api/v1/health', '/api/v1/settings', '/api/v1/applications']) {
      const result = await hostedApi.request(path, { headers: human });
      expect(result.status, path).toBe(200);
      privateResponse(result);
    }
    const today = await hostedApi.request('/api/v1/today?date=2026-11-%32%30', { headers: human });
    expect(today.status).toBe(200);
    expect(today.json.date).toBe('2026-11-20');
  });

  it('conserva parâmetros desconhecidos e repetidos para a validação da API', async () => {
    for (const path of ['/api/v1/health?path=cliente', '/api/v1/applications?limit=1&limit=2']) {
      const result = await hostedApi.request(path, { headers: human });
      expect(result.status, path).toBe(400);
      expect(result.json.error.code).toBe('INVALID_INPUT');
      privateResponse(result);
    }
  });

  it('encaminha POST sem query injetada até o limite de corpo', async () => {
    const options = {
      method: 'POST',
      headers: { ...human, 'content-type': 'application/json' },
      chunks: ['{', 'x'.repeat(300_000)],
    };
    const clean = await hostedApi.request('/api/v1/commands', options);
    expect(clean.status).toBe(413);
    expect(clean.json.error.code).toBe('PAYLOAD_TOO_LARGE');
    privateResponse(clean);
    const withQuery = await hostedApi.request('/api/v1/commands?path=cliente', options);
    expect(withQuery.status).toBe(400);
    expect(withQuery.json.error.code).toBe('INVALID_INPUT');
    privateResponse(withQuery);
  });
});

describe('contratos HTTP em PostgreSQL restrito', () => {
  it('nega sessão ausente, token de agente, outro proprietário e indisponibilidade de Auth', async () => {
    for (const [authorization, status] of [
      [undefined, 401],
      ['Bearer career_agent_secret', 401],
      ['Bearer other.payload.signature', 403],
      ['Bearer down.payload.signature', 503],
    ] as const) {
      const response = await api.request('/api/v1/applications', {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(status);
      privateResponse(response);
      expect(response.json.error.requestId).toBe(response.headers['x-request-id']);
      expect(Object.keys(response.json.error).sort()).toEqual(['code', 'message', 'requestId']);
    }
  });
  it('configura meta com versão e limita informações de integração', async () => {
    const current = await api.request('/api/v1/settings', { headers: human });
    expect(current.status).toBe(200);
    const settings = current.json;
    expect(Object.keys(settings).sort()).toEqual([
      'dailyGoal',
      'id',
      'integration',
      'timezone',
      'version',
    ]);
    const change = {
      operation: 'update_settings',
      settings: { id: settings.id, expectedVersion: settings.version },
      dailyGoal: 6,
      timezone: 'America/Sao_Paulo',
    };
    const updated = await post(change);
    expect(updated.status).toBe(200);
    expect(updated.json.settings.dailyGoal).toBe(6);
    expect((await post(change)).status).toBe(409);
  });
  it('mantém paginação estável em empates de microssegundos e busca literal', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const command = save();
      command.data.opportunity.company = 'Empate %_';
      const response = await post(command);
      expect(response.status).toBe(201);
      ids.push(response.json.application.id);
    }
    await admin.query(
      "UPDATE career.applications SET created_at='2026-11-16T12:00:00.123456Z' WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [owner, ids],
    );
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await api.request(
        '/api/v1/applications?limit=2&search=' +
          encodeURIComponent('%_') +
          (cursor ? '&cursor=' + cursor : ''),
        { headers: human },
      );
      expect(response.status).toBe(200);
      expect(response.json.total).toBe(5);
      for (const item of response.json.items) {
        collected.push(item.id);
        expect(item.createdAt).toBe('2026-11-16T12:00:00.123456Z');
      }
      cursor = response.json.nextCursor;
    } while (cursor);
    expect(collected).toEqual(ids.sort());
    expect(new Set(collected).size).toBe(5);
    expect(
      (await api.request('/api/v1/applications?sort=notes;DROP%20TABLE', { headers: human }))
        .status,
    ).toBe(400);
    expect(
      (
        await api.request('/api/v1/applications?filters=' + encodeURIComponent('{"ownerId":"x"}'), {
          headers: human,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.request(
          '/api/v1/applications?search=' +
            encodeURIComponent("'; DROP TABLE career.applications;--"),
          { headers: human },
        )
      ).json.total,
    ).toBe(0);
  });
  it('recusa períodos excessivos e texto não representável nos filtros com erro de entrada', async () => {
    const query = {
      operation: 'metrics',
      period: { from: '2000-01-01', to: '2026-11-16' },
      population: 'all',
      dimension: 'stack',
      submissionScope: 'all_dates',
    };
    expect(
      (
        await api.request('/api/v1/analytics?query=' + encodeURIComponent(JSON.stringify(query)), {
          headers: human,
        })
      ).status,
    ).toBe(400);
    expect((await api.request('/api/v1/applications?search=%00', { headers: human })).status).toBe(
      400,
    );
  });
  it('explica cada ID de analytics nas páginas e distingue grupo ausente de rótulo idêntico', async () => {
    const command = save();
    command.data.opportunity.stack = ['sem_stack_informada'] as never;
    const app = (await post(command)).json.application;
    const event = await post({
      operation: 'record_event',
      clientId: randomUUID(),
      application: { id: app.id, expectedVersion: 1 },
      data: {
        kind: 'retorno_substantivo',
        state: 'informado',
        occurredDate: { precision: 'day', certainty: 'exact', value: '2026-11-16' },
        resultText: 'Resultado',
        scoreValue: null,
        scoreUnit: null,
        sourceText: null,
        evidence: null,
      },
    });
    expect(event.status).toBe(201);
    await admin.query(
      "UPDATE career.events SET created_at='2026-11-16T10:20:30.123456Z' WHERE owner_id=$1 AND id=$2",
      [owner, event.json.event.id],
    );
    const query = {
      operation: 'metrics',
      period: { from: '2026-11-01', to: '2026-11-30' },
      population: 'all',
      dimension: 'stack',
      filters: { archived: 'include' },
      submissionScope: 'all_dates',
      asOf: '2026-11-16T10:20:30.123455Z',
    };
    const before = await api.request(
      '/api/v1/analytics?query=' + encodeURIComponent(JSON.stringify(query)),
      { headers: human },
    );
    expect(before.status).toBe(200);
    expect(before.json.metrics.response.numerator).toBe(0);
    const after = await api.request(
      '/api/v1/analytics?query=' +
        encodeURIComponent(JSON.stringify({ ...query, asOf: '2026-11-16T10:20:30.123456Z' })),
      { headers: human },
    );
    expect(after.status).toBe(200);
    expect(after.json.metrics.response.applicationIds).toEqual([app.id]);
    expect(
      after.json.groups.stack
        .filter((g: { key: string }) => g.key === 'sem_stack_informada')
        .map((g: { isMissing: boolean }) => g.isMissing)
        .sort(),
    ).toEqual([false, true]);
    const explaining = after.json.populations.selected.applicationIds;
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const path =
        '/api/v1/applications?limit=2&query=' +
        encodeURIComponent(JSON.stringify(after.json.query)) +
        '&explain=' +
        encodeURIComponent(JSON.stringify({ kind: 'population', name: 'selected' })) +
        (cursor ? '&cursor=' + cursor : '');
      const response = await api.request(path, { headers: human });
      expect(response.status).toBe(200);
      collected.push(...response.json.items.map((item: { id: string }) => item.id));
      cursor = response.json.nextCursor;
    } while (cursor);
    expect(collected.sort()).toEqual(explaining);
    expect(new Set(collected).size).toBe(explaining.length);
    const detail = await api.request('/api/v1/applications/' + app.id, { headers: human });
    expect(
      detail.json.events.find((e: { id: string }) => e.id === event.json.event.id).recordedAt,
    ).toBe('2026-11-16T10:20:30.123456Z');
  });
  it('cria referência de CV sem upload, pagina metadados e guarda associação realmente enviada', async () => {
    const result = await post({
      operation: 'create_resume_ref',
      clientId: randomUUID(),
      data: {
        label: 'CV fictício',
        stack: ['TS'],
        language: 'pt-BR',
        localRef: 'C:/ficticio/cv.pdf',
      },
    });
    expect(result.status).toBe(201);
    const ref = result.json.resumeRef;
    const refs = await api.request(
      '/api/v1/resume-refs?limit=1&search=' + encodeURIComponent('CV fictício'),
      { headers: human },
    );
    expect(refs.status).toBe(200);
    expect(refs.json.items[0].id).toBe(ref.id);
    const command = save();
    command.data.resumeIds = [ref.id] as never;
    const app = (await post(command)).json.application;
    const detail = await api.request('/api/v1/applications/' + app.id, { headers: human });
    expect(detail.json.resumeRefs.map((r: { id: string }) => r.id)).toEqual([ref.id]);
    expect((await api.request('/api/v1/resume-refs?limit=101', { headers: human })).status).toBe(
      400,
    );
  });
  it('Hoje separa datas exatas locais, desconhecidas e tarefas ordenadas', async () => {
    const command = save();
    command.data.submittedDate = {
      precision: 'instant',
      certainty: 'exact',
      value: '2026-11-17T01:30:00Z',
    } as never;
    const app = (await post(command)).json.application;
    let version = 1;
    for (const date of ['2026-11-18', '2026-11-15', '2026-11-16']) {
      const response = await post({
        operation: 'save_task',
        target: { clientId: randomUUID() },
        parents: { application: { id: app.id, expectedVersion: version++ }, contact: null },
        data: {
          title: 'Tarefa ' + date,
          dueDate: { precision: 'day', certainty: 'exact', value: date },
        },
      });
      expect(response.status).toBe(201);
    }
    const today = await api.request('/api/v1/today?date=2026-11-16', { headers: human });
    expect(today.status).toBe(200);
    expect(today.json.submitted.applicationIds).toContain(app.id);
    expect(today.json.tasks.map((t: { dueGroup: string }) => t.dueGroup)).toEqual([
      'overdue',
      'today',
      'future',
    ]);
    expect(today.json.unknownDateApplicationIds.length).toBeGreaterThan(0);
    expect((await api.request('/api/v1/today?date=2026-02-30', { headers: human })).status).toBe(
      400,
    );
  });
  it('Hoje preserva resultados históricos com envio desconhecido sem contar notas como resultados', async () => {
    const command = save();
    command.data.submissionStatus = 'nao_confirmado';
    command.data.cycleRelation = 'before_reset';
    const created = await post(command);
    expect(created.status).toBe(201);
    const app = created.json.application;
    const recorded: string[] = [];
    for (const [index, kind] of ['nota', 'entrevista'].entries()) {
      const response = await post({
        operation: 'record_event',
        clientId: randomUUID(),
        application: { id: app.id, expectedVersion: index + 1 },
        data: {
          kind,
          state: 'concluido',
          occurredDate: unknownDate,
          resultText: 'Fato histórico independente',
          scoreValue: null,
          scoreUnit: null,
          sourceText: null,
          evidence: null,
        },
      });
      expect(response.status).toBe(201);
      recorded.push(response.json.event.id);
    }
    const today = await api.request('/api/v1/today?date=2026-11-16', { headers: human });
    expect(today.status).toBe(200);
    expect(today.json.submitted.applicationIds).not.toContain(app.id);
    expect(
      today.json.historicalResults.some((event: { id: string }) => event.id === recorded[1]),
    ).toBe(true);
    expect(
      today.json.historicalResults.some((event: { id: string }) => event.id === recorded[0]),
    ).toBe(false);
    expect(
      (await api.request('/api/v1/applications/' + app.id, { headers: human })).json.application
        .submissionStatus,
    ).toBe('nao_confirmado');
  });
  it('detalhe inclui contato associado por conversa/link sem tarefa e história de alias', async () => {
    const app = (await post(save())).json.application;
    const alias = (await post(save())).json.application;
    const contact = (
      await post({
        operation: 'save_contact',
        target: { clientId: randomUUID() },
        data: { name: 'Recrutador fictício', notes: null, links: [] },
      })
    ).json.contact;
    await admin.query(
      "INSERT INTO career.links(owner_id,application_id,contact_id,original_url,kind,is_private) VALUES($1,$2,$3,$4,'conversa',true)",
      [owner, alias.id, contact.id, 'https://example.test/conversa?token=fictional'],
    );
    const linked = await post({
      operation: 'resolve_duplicate',
      application: { id: alias.id, expectedVersion: 1 },
      canonicalApplication: { id: app.id, expectedVersion: 1 },
      affectedBatches: [],
      reason: 'Alias fictício conferido',
      evidence: evidence(),
    });
    expect(linked.status).toBe(200);
    const detail = await api.request('/api/v1/applications/' + app.id, { headers: human });
    expect(detail.status).toBe(200);
    expect(detail.json.contacts.map((item: { id: string }) => item.id)).toContain(contact.id);
    expect(detail.json.application.historyApplicationIds.sort()).toEqual([app.id, alias.id].sort());
    expect(detail.json.links.some((link: { kind: string }) => link.kind === 'conversa')).toBe(true);
  });
  it('visão confirmada exclui aliases/invalidações e IDs explícitos preservam população após mudanças', async () => {
    const canonical = (await post(save())).json.application;
    const alias = (await post(save())).json.application;
    const invalid = (await post(save())).json.application;
    expect(
      (
        await post({
          operation: 'archive_application',
          application: { id: alias.id, expectedVersion: 1 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post({
          operation: 'resolve_duplicate',
          application: { id: alias.id, expectedVersion: 2 },
          canonicalApplication: { id: canonical.id, expectedVersion: 1 },
          affectedBatches: [],
          reason: 'Deduplicação fictícia',
          evidence: evidence(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post({
          operation: 'invalidate_submission',
          application: { id: invalid.id, expectedVersion: 1 },
          affectedBatches: [],
          reason: 'Confirmação inválida fictícia',
          evidence: evidence(),
        })
      ).status,
    ).toBe(200);
    const normal = await api.request(
      '/api/v1/applications?filters=' + encodeURIComponent(JSON.stringify({ archived: 'include' })),
      { headers: human },
    );
    expect(normal.status).toBe(200);
    const ids = normal.json.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(canonical.id);
    expect(ids).not.toContain(alias.id);
    expect(ids).not.toContain(invalid.id);
    const fixed = [alias.id, invalid.id];
    const explicit = await api.request(
      '/api/v1/applications?ids=' + encodeURIComponent(JSON.stringify(fixed)) + '&limit=1',
      { headers: human },
    );
    expect(explicit.status).toBe(200);
    const next = await api.request(
      '/api/v1/applications?ids=' +
        encodeURIComponent(JSON.stringify(fixed)) +
        '&limit=1&cursor=' +
        explicit.json.nextCursor,
      { headers: human },
    );
    expect(next.status).toBe(200);
    expect(
      [...explicit.json.items, ...next.json.items].map((item: { id: string }) => item.id).sort(),
    ).toEqual(fixed.sort());
    expect(
      (
        await api.request(
          '/api/v1/applications?ids=' +
            encodeURIComponent(JSON.stringify(fixed)) +
            '&filters=' +
            encodeURIComponent(JSON.stringify({ archived: 'exclude' })),
          { headers: human },
        )
      ).status,
    ).toBe(400);
  });
  it('limita tentativas, não converte manutenção/falha em sucesso e mantém cabeçalhos privados', async () => {
    const limited = await startApi({
      database,
      authenticate,
      rateLimit: { requests: 1, windowMs: 60000 },
      logger: () => undefined,
    });
    try {
      expect((await limited.request('/api/v1/health', { headers: human })).status).toBe(200);
      const response = await limited.request('/api/v1/health', { headers: human });
      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBeDefined();
      privateResponse(response);
    } finally {
      await limited.close();
    }
    const runId = randomUUID();
    const hash = 'a'.repeat(64);
    await admin.query(
      "INSERT INTO career.restore_runs(id,owner_id,destination_owner_id,manifest_hash,format_version,expected_rows,state) VALUES($1,$2,$2,$3,1,0,'restoring')",
      [runId, owner, hash],
    );
    await admin.query(
      "UPDATE career.maintenance_state SET state='restoring',active_restore_run_id=$2,manifest_hash=$3 WHERE owner_id=$1",
      [owner, runId, hash],
    );
    try {
      for (const path of ['/api/v1/health', '/api/v1/applications', '/api/v1/settings']) {
        const response = await api.request(path, { headers: human });
        expect(response.status).toBe(503);
        expect(response.json.error.code).toBe('MAINTENANCE');
        privateResponse(response);
      }
    } finally {
      await admin.query(
        "UPDATE career.maintenance_state SET state='ready',active_restore_run_id=NULL,manifest_hash=NULL WHERE owner_id=$1",
        [owner],
      );
      await admin.query('DELETE FROM career.restore_runs WHERE owner_id=$1 AND id=$2', [
        owner,
        runId,
      ]);
    }
    const failed = await startApi({
      database: {
        ...database,
        transaction: async () => {
          throw Error('postgres://private.invalid/secret');
        },
      },
      authenticate,
      logger: () => undefined,
    });
    try {
      const response = await failed.request('/api/v1/applications', { headers: human });
      expect(response.status).toBe(503);
      expect(response.text).not.toContain('private.invalid');
      privateResponse(response);
    } finally {
      await failed.close();
    }
  });
  it('recusa texto não representável e preserva Unicode válido sem normalizar', async () => {
    for (const text of ['bad\0text', 'bad\ud800text', 'bad\udc00text']) {
      const command = save();
      command.data.notes = text as never;
      expect((await post(command)).status).toBe(400);
    }
    const command = save();
    command.data.notes = '\ufeffCafé 🧭 漢字' as never;
    const response = await post(command);
    expect(response.status).toBe(201);
    expect(response.json.application.notes).toBe(command.data.notes);
  });
  it('conta bytes reais mesmo quando o adaptador informa Content-Length menor', async () => {
    const forwarded = await startApi(
      { database, authenticate, logger: () => undefined },
      (request) => {
        request.headers['content-length'] = '1';
      },
    );
    try {
      const response = await forwarded.request('/api/v1/commands', {
        method: 'POST',
        headers: { ...human, 'content-type': 'application/json' },
        chunks: ['{', 'x'.repeat(300000)],
      });
      expect(response.status).toBe(413);
      privateResponse(response);
    } finally {
      await forwarded.close();
    }
  });
  it('adaptadores local/Vercel falham fechados sem configuração ou com origem divergente', async () => {
    for (const env of [
      {},
      { VERCEL_ENV: 'preview', DATABASE_URL: 'postgresql://private.invalid/secret' },
      { VITE_SUPABASE_URL: 'https://wrong.example.test' },
    ]) {
      const runtime = createRuntimeApp(env);
      const target = await startHandler(runtime.handler);
      try {
        const response = await target.request('/api/v1/health');
        expect(response.status).toBe(503);
        privateResponse(response);
        expect(response.text).not.toContain('private.invalid');
      } finally {
        await target.close();
        await runtime.close();
      }
    }
    const vercel = await import('../../api/index');
    const target = await startHandler(vercel.default);
    try {
      const response = await target.request('/api/v1/health');
      expect(response.status).toBe(503);
      privateResponse(response);
    } finally {
      await target.close();
    }
  });
  it('prévia de importação é somente leitura e restauração distingue estrutura de prontidão real', async () => {
    const input = sourceUpload();
    const before = (
      await admin.query('SELECT count(*)::int AS n FROM career.audit_log WHERE owner_id=$1', [
        owner,
      ])
    ).rows[0].n;
    const preview = await transferPost('imports/preview', {
      bytesBase64: input.sources[0]!.bytesBase64,
    });
    expect(preview.status).toBe(200);
    expect(preview.json.writes).toBe(false);
    expect(preview.json.parsed.rows).toHaveLength(1);
    const snapshot = buildSnapshot(owner, []);
    const restore = await transferPost('restores/preview', { snapshot });
    expect(restore.status).toBe(200);
    expect(restore.json).toMatchObject({
      validation: 'structural_only',
      destinationReady: null,
      destinationSqlPreflight: 'not_performed',
      nextAction: 'local_owner_maintenance_preview',
    });
    expect(restore.json).not.toHaveProperty('ready');
    privateResponse(restore);
    expect(
      (
        await admin.query('SELECT count(*)::int AS n FROM career.audit_log WHERE owner_id=$1', [
          owner,
        ])
      ).rows[0].n,
    ).toBe(before);
    expect(
      (await transferPost('restores/preview', { snapshot: { ...snapshot, entities: [{}] } }))
        .status,
    ).toBe(400);
    expect(
      (await transferPost('imports/apply', { unit: 'prepare', data: input, ownerId: owner }))
        .status,
    ).toBe(400);
    expect(
      (
        await transferPost('imports/apply', {
          unit: 'prepare',
          data: sourceUpload(1, 9901, 0, 'bad\0text'),
        })
      ).status,
    ).toBe(400);
  });
  it('exportação acima do limite recusa o arquivo inteiro e orienta o fluxo local', async () => {
    const runId = randomUUID(),
      fileId = randomUUID();
    const bytes = Buffer.alloc(3_000_000, 7);
    await admin.query(
      "INSERT INTO career.import_runs(id,owner_id,importer_version,source_set_hash) VALUES($1,$2,'fixture',$3)",
      [runId, owner, sha256(randomUUID())],
    );
    await admin.query(
      'INSERT INTO career.source_files(id,owner_id,import_run_id,file_name,file_hash,original_bytes,original_text) VALUES($1,$2,$3,$4,$5,$6,NULL)',
      [fileId, owner, runId, 'arquivo-sintetico.bin', sha256(bytes), bytes],
    );
    try {
      const response = await api.request('/api/v1/exports?format=json', { headers: human });
      expect(response.status).toBe(413);
      privateResponse(response);
      expect(response.json.error.code).toBe('EXPORT_TOO_LARGE');
      expect(response.json.error.message).toContain('local');
      expect(response.json).not.toHaveProperty('entities');
    } finally {
      await admin.query('DELETE FROM career.source_files WHERE owner_id=$1 AND id=$2', [
        owner,
        fileId,
      ]);
      await admin.query('DELETE FROM career.import_runs WHERE owner_id=$1 AND id=$2', [
        owner,
        runId,
      ]);
    }
    const tooLarge = await api.request('/api/v1/imports/preview', {
      method: 'POST',
      headers: { ...human, 'content-type': 'application/json' },
      chunks: ['{', 'x'.repeat(4_000_001)],
    });
    expect(tooLarge.status).toBe(413);
    privateResponse(tooLarge);
  });
  it('reserva HTTP, unidade de importação e auditoria revertem juntas, inclusive prepare acima de 256 KiB', async () => {
    const input = sourceUpload();
    const key = randomUUID();
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(256 * 1024);
    const before = (
      await admin.query('SELECT count(*)::int AS n FROM career.audit_log WHERE owner_id=$1', [
        owner,
      ])
    ).rows[0].n;
    let failed = false;
    const faulted = await startApi({
      database: {
        ...database,
        transaction: (actor, work, context) =>
          database.transaction(
            actor,
            (tx) =>
              work(
                new Proxy(tx, {
                  get(target, property) {
                    if (property !== 'query') return Reflect.get(target, property);
                    return async (sql: string, values?: unknown[]) => {
                      if (sql.includes('UPDATE career.mutation_keys') && !failed) {
                        failed = true;
                        throw new SafeError('DATABASE_UNAVAILABLE');
                      }
                      return target.query(sql, values);
                    };
                  },
                }),
              ),
            context,
          ),
      },
      authenticate,
      logger: () => undefined,
    });
    try {
      const response = await transferPost(
        'imports/apply',
        { unit: 'prepare', data: input },
        key,
        faulted,
      );
      expect(response.status).toBe(503);
      privateResponse(response);
    } finally {
      await faulted.close();
    }
    expect(failed).toBe(true);
    for (const table of ['import_runs', 'source_files'])
      expect(
        (
          await admin.query(`SELECT count(*)::int AS n FROM career.${table} WHERE owner_id=$1`, [
            owner,
          ])
        ).rows[0].n,
      ).toBe(0);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM career.mutation_keys WHERE owner_id=$1 AND idempotency_key=$2',
          [owner, key],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await admin.query('SELECT count(*)::int AS n FROM career.audit_log WHERE owner_id=$1', [
          owner,
        ])
      ).rows[0].n,
    ).toBe(before);
    const prepared = await transferPost('imports/apply', { unit: 'prepare', data: input }, key);
    expect(prepared.status).toBe(200);
    const runId = prepared.json.runId;
    expect(
      (await transferPost('imports/apply', { unit: 'prepare', data: input }, randomUUID())).json,
    ).toEqual(prepared.json);
    const data = {
      runId,
      legacyId: 'V9701',
      expectedVersion: null,
      expectedOpportunityVersion: null,
      interpretation: {
        track: null,
        applicationInstance: 'initial',
        cycleRelation: 'unknown',
        kind: 'desconhecido',
        provider: null,
        tenant: null,
      },
      decisions: null,
      historicalEvents: [],
      affectedBatches: [],
    };
    let failLedger = true;
    const interrupted = await startApi({
      database: {
        ...database,
        transaction: (actor, work, context) =>
          database.transaction(
            actor,
            (tx) =>
              work(
                new Proxy(tx, {
                  get(target, property) {
                    if (property !== 'query') return Reflect.get(target, property);
                    return async (sql: string, values?: unknown[]) => {
                      if (sql.includes('INSERT INTO career.import_rows') && failLedger) {
                        failLedger = false;
                        throw new SafeError('DATABASE_UNAVAILABLE');
                      }
                      return target.query(sql, values);
                    };
                  },
                }),
              ),
            context,
          ),
      },
      authenticate,
      logger: () => undefined,
    });
    const applicationKey = randomUUID();
    try {
      expect(
        (
          await transferPost(
            'imports/apply',
            { unit: 'application', data },
            applicationKey,
            interrupted,
          )
        ).status,
      ).toBe(503);
    } finally {
      await interrupted.close();
    }
    expect(
      (
        await admin.query('SELECT id FROM career.applications WHERE owner_id=$1 AND legacy_id=$2', [
          owner,
          'V9701',
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query(
          'SELECT id FROM career.mutation_keys WHERE owner_id=$1 AND idempotency_key=$2',
          [owner, applicationKey],
        )
      ).rows,
    ).toEqual([]);
    let loseAck = true;
    const uncertain = await startApi({
      database: {
        ...database,
        transaction: async (actor, work, context) => {
          let pid: number | undefined;
          const result = await database.transaction(
            actor,
            async (tx) => {
              pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
                .pid;
              return work(tx);
            },
            context,
          );
          if (loseAck) {
            loseAck = false;
            await admin.query('SELECT pg_terminate_backend($1)', [pid]);
            throw new SafeError('DATABASE_UNAVAILABLE');
          }
          return result;
        },
      },
      authenticate,
      logger: () => undefined,
    });
    try {
      const response = await transferPost(
        'imports/apply',
        { unit: 'application', data },
        applicationKey,
        uncertain,
      );
      expect(response.status).toBe(503);
      const retried = await transferPost(
        'imports/apply',
        { unit: 'application', data },
        applicationKey,
        uncertain,
      );
      expect(retried.status).toBe(200);
      expect(retried.json.result).toBe('imported');
      expect(
        (await transferPost('imports/apply', { unit: 'application', data }, randomUUID())).json,
      ).toEqual(retried.json);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM career.events WHERE owner_id=$1 AND application_id=$2 AND kind='envio_confirmado'",
            [owner, retried.json.applicationId],
          )
        ).rows[0].n,
      ).toBe(1);
      const audit = (
        await admin.query(
          'SELECT actor_kind,source,request_id FROM career.audit_log WHERE owner_id=$1 AND entity_id=$2',
          [owner, retried.json.applicationId],
        )
      ).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_kind: 'import',
        source: IMPORTER_VERSION,
        request_id: response.headers['x-request-id'],
      });
    } finally {
      await uncertain.close();
    }
    const complete = { unit: 'complete', data: { runId, reviewRequired: false } };
    expect((await transferPost('imports/apply', complete)).status).toBe(200);
    expect((await transferPost('imports/preview', { runId })).status).toBe(200);
    const exported = await api.request('/api/v1/exports?format=json', { headers: human });
    expect(exported.status).toBe(200);
    privateResponse(exported);
    expect(
      exported.json.entities.some((entity: { table: string }) => entity.table === 'source_files'),
    ).toBe(true);
    const csv = await api.request('/api/v1/exports?format=csv', { headers: human });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
  });
  it('importa revisão em unidade limitada, mantém versão congelada e distingue resultados posteriores', async () => {
    const prefix = '\ufeff# Revisão 🧭\n';
    const boundedMarkdown = prefix + 'x'.repeat(50000 - prefix.length);
    const input = sourceUpload(30, 9801, 0, boundedMarkdown);
    const cycle = (
      await admin.query('SELECT id,version FROM career.cycles WHERE owner_id=$1 AND is_current', [
        owner,
      ])
    ).rows[0]!;
    input.cycle.id = cycle.id;
    input.cycle.expectedVersion = cycle.version;
    const prepared = await transferPost('imports/apply', { unit: 'prepare', data: input });
    expect(prepared.status).toBe(200);
    const members: {
      legacyId: string;
      capturedOrder: number;
      expectedVersion: number;
      id: string;
    }[] = [];
    for (let index = 0; index < 30; index++) {
      const legacyId = 'V' + (9801 + index);
      const response = await transferPost('imports/apply', {
        unit: 'application',
        data: {
          runId: prepared.json.runId,
          legacyId,
          expectedVersion: null,
          expectedOpportunityVersion: null,
          interpretation: {
            track: null,
            applicationInstance: 'initial',
            cycleRelation: 'after_reset',
            kind: 'desconhecido',
            provider: null,
            tenant: null,
          },
          decisions: null,
        },
      });
      expect(response.status).toBe(200);
      members.push({
        legacyId,
        capturedOrder: index + 1,
        expectedVersion: 1,
        id: response.json.applicationId,
      });
    }
    const snapshot = {
      schemaVersion: 1,
      asOf: '2026-11-16T12:00:00.123456Z',
      period: null,
      populationIds: members.map((v) => v.id),
      eventIds: [],
      metrics: {},
      externalResultApplicationIds: [],
      externalResultEventIds: [],
    };
    const data = {
      runId: prepared.json.runId,
      batchNumber: 1,
      members: members.map(({ legacyId, capturedOrder, expectedVersion }) => ({
        legacyId,
        capturedOrder,
        expectedVersion,
      })),
      markdownFile: 'revisao.md',
      closedAt: null,
      historicalClosedDate: unknownDate,
      documentedUpdatedDate: unknownDate,
      snapshotTimeMeaning: 'import_capture',
      snapshot,
      pendingIssues: [],
    };
    const response = await transferPost('imports/apply', { unit: 'review', data });
    expect(response.status).toBe(200);
    expect((await transferPost('imports/apply', { unit: 'review', data })).json).toEqual(
      response.json,
    );
    const detail = await api.request('/api/v1/batches/' + response.json.batchId, {
      headers: human,
    });
    expect(detail.status).toBe(200);
    expect(detail.json.members).toHaveLength(30);
    const list = await api.request('/api/v1/batches?limit=1', { headers: human });
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(1);
    expect(list.json.items[0].id).toBe(response.json.batchId);
    const version = await api.request('/api/v1/reviews/' + response.json.reviewId, {
      headers: human,
    });
    expect(version.status).toBe(200);
    expect(version.json.version.snapshot).toEqual(snapshot);
    expect(version.json.version.closedAt).toBeNull();
    expect(version.json.version.originalMarkdown).toBe(
      Buffer.from(input.sources[1]!.bytesBase64, 'base64').toString('utf8'),
    );
    const later = await post({
      operation: 'record_event',
      clientId: randomUUID(),
      application: { id: members[0]!.id, expectedVersion: 1 },
      data: {
        kind: 'entrevista',
        state: 'concluido',
        occurredDate: unknownDate,
        resultText: 'Resultado posterior',
        scoreValue: null,
        scoreUnit: null,
        sourceText: null,
        evidence: null,
      },
    });
    expect(later.status).toBe(201);
    const reread = await api.request('/api/v1/reviews/' + response.json.reviewId, {
      headers: human,
    });
    expect(reread.json.version.snapshot).toEqual(snapshot);
    expect(
      reread.json.laterResults.some((event: { id: string }) => event.id === later.json.event.id),
    ).toBe(true);
    expect(
      (
        await transferPost('imports/apply', {
          unit: 'complete',
          data: { runId: prepared.json.runId, reviewRequired: true },
        })
      ).status,
    ).toBe(200);
    const large = sourceUpload(30, 9801, 0, boundedMarkdown + 'x');
    const current = (
      await admin.query('SELECT id,version FROM career.cycles WHERE owner_id=$1 AND is_current', [
        owner,
      ])
    ).rows[0]!;
    large.cycle.id = current.id;
    large.cycle.expectedVersion = current.version;
    const largeRun = await transferPost('imports/apply', { unit: 'prepare', data: large });
    expect(largeRun.status).toBe(200);
    const reviewInventory = async () =>
      (await admin.query(`SELECT
        (SELECT count(*) FROM career.batches WHERE owner_id=$1)::int AS batches,
        (SELECT count(*) FROM career.review_versions WHERE owner_id=$1)::int AS reviews,
        (SELECT count(*) FROM career.audit_log WHERE owner_id=$1)::int AS audits`, [owner])).rows[0];
    const inventoryBefore = await reviewInventory();
    const counts = (
      await admin.query('SELECT count(*)::int AS n FROM career.review_versions WHERE owner_id=$1', [
        owner,
      ])
    ).rows[0].n;
    const largeKey = randomUUID();
    const rejected = await transferPost(
      'imports/apply',
      {
        unit: 'review',
        data: {
          ...data,
          runId: largeRun.json.runId,
          batchNumber: 2,
          members: data.members.map((member, index) => ({
            ...member,
            expectedVersion: index === 0 ? 2 : 1,
          })),
        },
      },
      largeKey,
    );
    expect(rejected.status).toBe(413);
    expect(await reviewInventory()).toEqual(inventoryBefore);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM career.review_versions WHERE owner_id=$1',
          [owner],
        )
      ).rows[0].n,
    ).toBe(counts);
    expect(
      (
        await admin.query(
          'SELECT id FROM career.mutation_keys WHERE owner_id=$1 AND idempotency_key=$2',
          [owner, largeKey],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await transferPost('imports/apply', {
          unit: 'review',
          data: { ...data, batchNumber: 2147483648 },
        })
      ).status,
    ).toBe(400);
    const exported = await api.request('/api/v1/exports?format=json', { headers: human });
    expect(exported.status).toBe(200);
    const snapshotAfter = validateSnapshot(exported.json);
    expect(
      snapshotAfter.entities.some(
        (entity) =>
          entity.table === 'source_files' && entity.data.originalText === boundedMarkdown + 'x',
      ),
    ).toBe(true);
    // Captura opcional só do fixture sintético, para a regressão local de recovery.
    if (process.env.TASK12_CAPTURE_SNAPSHOT)
      await writeFile(process.env.TASK12_CAPTURE_SNAPSHOT, JSON.stringify(snapshotAfter), {
        encoding: 'utf8',
        flag: 'wx',
      });
  });
  it('health verifica dependência sem expor configuração; rotas e métodos desconhecidos não viram SPA', async () => {
    const health = await api.request('/api/v1/health', { headers: human });
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ status: 'ok' });
    privateResponse(health);
    for (const [path, method, status] of [
      ['/api/v1/missing', 'GET', 404],
      ['/api/v1/applications', 'POST', 405],
      ['/api/v1/signup', 'POST', 404],
      ['/api/v1/restores/apply', 'POST', 404],
    ] as const) {
      const response = await api.request(path, { method, headers: human });
      expect(response.status).toBe(status);
      privateResponse(response);
      expect(response.text).not.toContain('<html');
    }
  });
  it('valida JSON, campos extras, chave obrigatória e limites antes do parse', async () => {
    for (const body of [
      '{',
      JSON.stringify({ ...save(), ownerId: owner }),
      JSON.stringify({ ...save(), actor: 'owner' }),
    ]) {
      const response = await api.request('/api/v1/commands', {
        method: 'POST',
        headers: { ...human, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body,
      });
      expect(response.status).toBe(400);
      privateResponse(response);
    }
    expect(
      (
        await api.request('/api/v1/commands', {
          method: 'POST',
          headers: { ...human, 'content-type': 'application/json' },
          body: JSON.stringify(save()),
        })
      ).status,
    ).toBe(400);
    const response = await api.request('/api/v1/commands', {
      method: 'POST',
      headers: { ...human, 'content-type': 'application/json' },
      chunks: ['{', 'x'.repeat(300_000)],
    });
    expect(response.status).toBe(413);
    privateResponse(response);
  });
  it('grava texto inerte, replay atômico, requestId auditado, detalhe e conflito seguro', async () => {
    const command = save();
    command.data.notes = "<script>alert(1)</script>'; DROP TABLE career.applications;--" as never;
    const key = randomUUID();
    const response = await post(command, key);
    expect(response.status).toBe(201);
    privateResponse(response);
    const app = response.json.application;
    expect(app.notes).toBe(command.data.notes);
    expect(app.opportunity).toMatchObject({ version: 1, company: 'Empresa fictícia' });
    expect((await post(command, key)).json).toEqual(response.json);
    expect(
      (await post({ ...command, data: { ...command.data, notes: 'changed' } }, key)).status,
    ).toBe(409);
    const audit = (
      await admin.query(
        'SELECT request_id FROM career.audit_log WHERE owner_id=$1 AND entity_id=$2',
        [owner, app.id],
      )
    ).rows;
    expect(audit.some((row) => row.request_id === response.headers['x-request-id'])).toBe(true);
    const detail = await api.request('/api/v1/applications/' + app.id, { headers: human });
    expect(detail.status).toBe(200);
    expect(detail.json.application.notes).toBe(command.data.notes);
    expect(detail.json).toMatchObject({ links: [], tasks: [], contacts: [], resumeRefs: [] });
    expect(
      (await api.request('/api/v1/applications/' + randomUUID(), { headers: human })).status,
    ).toBe(404);
    const update = {
      operation: 'update_application',
      application: { id: app.id, expectedVersion: 1 },
      changes: { notes: 'new' },
    };
    expect((await post(update)).status).toBe(200);
    const stale = await post(update);
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.currentVersion).toBe(2);
    privateResponse(stale);
  });
});
