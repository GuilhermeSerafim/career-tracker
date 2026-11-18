import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it as vitestIt } from 'vitest';
import { authenticateBearer } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase } from '../../server/database';
import { provisionOwner } from '../../scripts/provision-owner';
import { connectTestDatabase } from '../helpers/database';
import { startApi } from '../helpers/api';
import { unknownDate } from '../fixtures/career';

const owner = randomUUID();
const bearer = 'Bearer synthetic.payload.signature';
let admin: pg.Client;
let database: ReturnType<typeof createDatabase>;
let api: Awaited<ReturnType<typeof startApi>>;
let tables: string[] = [];
let authCalls = 0;

/** Socket TCP real: conserva linhas duplicadas, ordem e caixa no fio. */
function rawRequest(method: string, path: string, headers: [string, string][], body = '') {
  return new Promise<{
    status: number;
    headers: Record<string, string>;
    json: Record<string, unknown>;
  }>((resolve, reject) => {
    const socket = connect(api.port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('connect', () =>
      socket.write(
        [
          `${method} ${path} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Connection: close',
          `Content-Length: ${Buffer.byteLength(body)}`,
          ...headers.map(([name, value]) => `${name}: ${value}`),
          '',
          body,
        ].join('\r\n'),
      ),
    );
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        const bytes = Buffer.concat(chunks);
        const boundary = bytes.indexOf('\r\n\r\n');
        if (boundary < 0) throw Error('Resposta HTTP ausente.');
        const lines = bytes.subarray(0, boundary).toString('ascii').split('\r\n');
        const status = Number(lines.shift()!.split(' ')[1]);
        const responseHeaders = Object.fromEntries(
          lines.map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
          }),
        );
        let payload = bytes.subarray(boundary + 4);
        if (responseHeaders['transfer-encoding'] === 'chunked') {
          const decoded: Buffer[] = [];
          let offset = 0;
          while (offset < payload.length) {
            const end = payload.indexOf('\r\n', offset);
            const size = Number.parseInt(payload.subarray(offset, end).toString('ascii'), 16);
            if (end < 0 || !Number.isFinite(size)) throw Error('Chunk HTTP inválido.');
            if (!size) break;
            decoded.push(payload.subarray(end + 2, end + 2 + size));
            offset = end + size + 4;
          }
          payload = Buffer.concat(decoded);
        }
        resolve({ status, headers: responseHeaders, json: JSON.parse(payload.toString('utf8')) });
      } catch (error) {
        reject(error);
      }
    });
  });
}
const post = (command: unknown) =>
  api.request('/api/v1/commands', {
    method: 'POST',
    headers: {
      authorization: bearer,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(command),
  });
const get = (path: string) =>
  api.request('/api/v1/' + path, { headers: { authorization: bearer } });
const evidence = () => ({
  clientId: randomUUID(),
  kind: 'relato_usuario',
  originalText: 'Relato sintético.',
  source: null,
  occurredDate: unknownDate,
  privateRef: null,
  localRef: null,
});
const save = (cycleRelation: 'unknown' | 'after_reset') => ({
  operation: 'save_application',
  clientId: randomUUID(),
  data: {
    opportunity: {
      company: 'Empresa sintética',
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
    cycleRelation,
    discoveryChannel: null,
    submissionPlatform: null,
    notes: null,
    resumeIds: [],
    links: [],
  },
  evidence: evidence(),
});
function privateError(response: Awaited<ReturnType<typeof rawRequest>>) {
  expect(response.status).toBe(400);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers.vary).toBe('Authorization');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  expect(response.json).toEqual({
    error: {
      code: 'INVALID_INPUT',
      message: expect.any(String),
      requestId: response.headers['x-request-id'],
    },
  });
}
async function inventory() {
  return (
    await admin.query(
      `SELECT jsonb_object_agg(name,n) AS counts FROM (${tables.map((table) => `SELECT '${table}'::text AS name,count(*)::int AS n FROM career.${table} WHERE owner_id=$1`).join(' UNION ALL ')}) counts`,
      [owner],
    )
  ).rows[0].counts;
}
beforeAll(async () => {
  admin = await connectTestDatabase();
  tables = (
    await admin.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='career' ORDER BY tablename",
    )
  ).rows.map((row) => row.tablename);
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
  api = await startApi({
    database,
    authenticate: (header) => {
      authCalls++;
      return authenticateBearer(header, config, {
        getUser: async () => ({ data: { user: { id: owner } }, error: null }),
      });
    },
    logger: () => undefined,
  });
});
afterAll(async () => {
  await api?.close();
  await database?.close();
  if (admin) {
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    for (const table of tables)
      await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [owner]);
    await admin.query('COMMIT');
    await admin.end();
  }
});
let running: Promise<void> | undefined;
afterEach(async () => { await running?.catch(() => undefined); running = undefined; }, 45_000);
function it(name: string, work: () => Promise<void>, timeout = 15_000) {
  vitestIt(name, async () => { running = work(); await running; }, timeout);
}
describe('fronteiras HTTP de cabeçalhos e atribuição histórica', () => {
  it('recusa Authorization duplicado antes de autenticar em ambas as ordens, idênticos e caixa mista', async () => {
    const before = await inventory();
    const attempts = authCalls;
    for (const values of [
      [bearer, 'Bearer invalid'],
      ['Bearer invalid', bearer],
      [bearer, bearer],
    ]) {
      for (const names of [
        ['Authorization', 'Authorization'],
        ['authorization', 'AUTHORIZATION'],
      ]) {
        const fields: [string, string][] = [
          [names[0]!, values[0]!],
          [names[1]!, values[1]!],
        ];
        privateError(await rawRequest('GET', '/api/v1/health', fields));
        const body = JSON.stringify({
          operation: 'create_resume_ref',
          clientId: randomUUID(),
          data: { label: 'CV sintético', stack: [], language: null, localRef: null },
        });
        privateError(
          await rawRequest(
            'POST',
            '/api/v1/commands',
            [...fields, ['Content-Type', 'application/json'], ['Idempotency-Key', randomUUID()]],
            body,
          ),
        );
      }
    }
    expect(authCalls).toBe(attempts);
    expect(await inventory()).toEqual(before);
  });
  it('recusa Content-Type duplicado antes de autenticar/interpretar/gravar, inclusive valores idênticos', async () => {
    const before = await inventory();
    const attempts = authCalls;
    for (const values of [
      ['application/json', 'text/plain'],
      ['text/plain', 'application/json'],
      ['application/json', 'application/json'],
    ]) {
      for (const names of [
        ['Content-Type', 'Content-Type'],
        ['content-type', 'CONTENT-TYPE'],
      ]) {
        const body = JSON.stringify({
          operation: 'create_resume_ref',
          clientId: randomUUID(),
          data: { label: 'CV sintético', stack: [], language: null, localRef: null },
        });
        privateError(
          await rawRequest(
            'POST',
            '/api/v1/commands',
            [
              ['Authorization', bearer],
              [names[0]!, values[0]!],
              [names[1]!, values[1]!],
              ['Idempotency-Key', randomUUID()],
            ],
            body,
          ),
        );
      }
    }
    expect(authCalls).toBe(attempts);
    expect(await inventory()).toEqual(before);
  });
  it('revisão congelada inclui correção efetiva no alias sem alterar população, IDs, horários ou versão', async () => {
    expect(
      (
        await post({
          operation: 'start_cycle',
          clientId: randomUUID(),
          resetDate: unknownDate,
          resetMarker: null,
        })
      ).status,
    ).toBe(201);
    const members: string[] = [];
    for (let index = 0; index < 30; index++) {
      const result = await post(save('after_reset'));
      expect(result.status).toBe(201);
      members.push(result.json.application.id);
    }
    const batch = (await get('batches')).json.items[0];
    const closed = await post({
      operation: 'close_review',
      batch: { id: batch.id, expectedVersion: batch.version },
      narrative: 'Revisão congelada sintética',
      decisions: [],
    });
    expect(closed.status).toBe(201);
    const before = (await get('reviews/' + closed.json.reviewId)).json.version;
    const membershipBefore = (await get('batches/' + batch.id)).json.members;
    const alias = (await post(save('unknown'))).json.application;
    const eventData = {
      kind: 'entrevista',
      state: 'informado',
      occurredDate: unknownDate,
      resultText: 'Entrevista no alias',
      scoreValue: null,
      scoreUnit: null,
      sourceText: null,
      evidence: null,
    };
    const original = await post({
      operation: 'record_event',
      clientId: randomUUID(),
      application: { id: alias.id, expectedVersion: 1 },
      data: eventData,
    });
    expect(original.status).toBe(201);
    const merged = await post({
      operation: 'resolve_duplicate',
      application: { id: alias.id, expectedVersion: 2 },
      canonicalApplication: { id: members[0], expectedVersion: 1 },
      affectedBatches: [{ id: batch.id, expectedVersion: closed.json.batchVersion }],
      reason: 'Duplicata sintética conferida',
      evidence: evidence(),
    });
    expect(merged.status).toBe(200);
    const corrected = await post({
      operation: 'correct_event',
      clientId: randomUUID(),
      application: { id: members[0], expectedVersion: merged.json.application.version },
      eventId: original.json.event.id,
      replacement: {
        ...eventData,
        state: 'concluido',
        resultText: 'Entrevista concluída corrigida',
      },
      reason: 'Correção de fato sintético',
      evidence: evidence(),
    });
    expect(corrected.status).toBe(201);
    const external = (await post(save('unknown'))).json.application;
    const unrelated = await post({
      operation: 'record_event',
      clientId: randomUUID(),
      application: { id: external.id, expectedVersion: 1 },
      data: eventData,
    });
    expect(unrelated.status).toBe(201);
    const after = await get('reviews/' + closed.json.reviewId);
    expect(after.status).toBe(200);
    expect(after.json.version).toEqual(before);
    expect(after.json.version.populationIds).toHaveLength(30);
    expect(after.json.version.populationIds).not.toContain(alias.id);
    expect((await get('batches/' + batch.id)).json.members).toEqual(membershipBefore);
    const fact = after.json.laterResults.find(
      (event: { id: string }) => event.id === corrected.json.event.id,
    );
    expect(fact).toMatchObject({
      id: corrected.json.event.id,
      applicationId: alias.id,
      canonicalApplicationId: members[0],
      recordedAt: corrected.json.event.recordedAt,
      kind: 'entrevista',
      state: 'concluido',
      resultText: 'Entrevista concluída corrigida',
    });
    expect(
      after.json.laterResults.some((event: { id: string }) => event.id === original.json.event.id),
    ).toBe(false);
    expect(
      after.json.laterResults.some((event: { id: string }) => event.id === unrelated.json.event.id),
    ).toBe(false);
    const detail = await get('applications/' + members[0]);
    expect(
      detail.json.events.find((event: { id: string }) => event.id === corrected.json.event.id),
    ).toMatchObject({ applicationId: alias.id, recordedAt: corrected.json.event.recordedAt });
    const today = await get('today?date=2026-11-16');
    expect(
      today.json.recentEvents.find((event: { id: string }) => event.id === corrected.json.event.id),
    ).toMatchObject({ canonicalApplicationId: members[0] });
    const direct = await post({
      operation: 'record_event',
      clientId: randomUUID(),
      application: { id: members[0], expectedVersion: corrected.json.parents.application.version },
      data: { ...eventData, resultText: 'Entrevista física no membro congelado' },
    });
    expect(direct.status).toBe(201);
    expect(
      (await get('reviews/' + closed.json.reviewId)).json.laterResults.find(
        (event: { id: string }) => event.id === direct.json.event.id,
      ),
    ).toMatchObject({ applicationId: members[0], recordedAt: direct.json.event.recordedAt });
    const target = (await post(save('unknown'))).json.application;
    const latestBatch = (await get('batches/' + batch.id)).json.batch;
    const outward = await post({
      operation: 'resolve_duplicate',
      application: { id: members[0], expectedVersion: direct.json.parents.application.version },
      canonicalApplication: { id: target.id, expectedVersion: 1 },
      affectedBatches: [{ id: batch.id, expectedVersion: latestBatch.version }],
      reason: 'Membro congelado reconciliado com registro externo',
      evidence: evidence(),
    });
    expect(outward.status).toBe(200);
    const afterOutward = await get('reviews/' + closed.json.reviewId);
    expect(afterOutward.status).toBe(200);
    expect(afterOutward.json.version).toEqual(before);
    expect(afterOutward.json.version.populationIds).toHaveLength(30);
    expect(afterOutward.json.version.populationIds).toContain(members[0]);
    expect(afterOutward.json.version.populationIds).not.toContain(target.id);
    expect((await get('batches/' + batch.id)).json.members).toEqual(membershipBefore);
    expect(
      afterOutward.json.laterResults.find(
        (event: { id: string }) => event.id === direct.json.event.id,
      ),
    ).toMatchObject({
      id: direct.json.event.id,
      applicationId: members[0],
      canonicalApplicationId: target.id,
      recordedAt: direct.json.event.recordedAt,
      resultText: 'Entrevista física no membro congelado',
    });
    // Também conserva a atribuição pela cadeia de duas ligações alias -> membro -> alvo.
    expect(
      afterOutward.json.laterResults.find(
        (event: { id: string }) => event.id === corrected.json.event.id,
      ),
    ).toMatchObject({
      applicationId: alias.id,
      canonicalApplicationId: target.id,
      recordedAt: corrected.json.event.recordedAt,
    });
    expect(
      afterOutward.json.laterResults.some(
        (event: { id: string }) => event.id === original.json.event.id,
      ),
    ).toBe(false);
    expect(
      afterOutward.json.laterResults.some(
        (event: { id: string }) => event.id === unrelated.json.event.id,
      ),
    ).toBe(false);
    expect(
      (await get('applications/' + target.id)).json.events.find(
        (event: { id: string }) => event.id === direct.json.event.id,
      ),
    ).toEqual(
      (await get('applications/' + members[0])).json.events.find(
        (event: { id: string }) => event.id === direct.json.event.id,
      ),
    );
    // Corrupção administrativa sintética: as operações normais recusam ciclos.
    // A leitura deve falhar fechada, sem reinterpretar a versão congelada.
    const broken = (await post(save('unknown'))).json.application;
    await admin.query(
      `UPDATE career.applications SET canonical_application_id=CASE WHEN id=$2 THEN $3::uuid ELSE $2::uuid END
      WHERE owner_id=$1 AND id=ANY($4::uuid[])`,
      [owner, external.id, broken.id, [external.id, broken.id]],
    );
    try {
      const corrupt = await get('reviews/' + closed.json.reviewId);
      expect(corrupt.status).toBe(503);
      expect(corrupt.json.error).toMatchObject({
        code: 'DATABASE_UNAVAILABLE',
        requestId: corrupt.headers['x-request-id'],
      });
      expect(corrupt.json).not.toHaveProperty('laterResults');
    } finally {
      await admin.query(
        'UPDATE career.applications SET canonical_application_id=NULL WHERE owner_id=$1 AND id=ANY($2::uuid[])',
        [owner, [external.id, broken.id]],
      );
    }
    expect((await get('reviews/' + closed.json.reviewId)).json.version).toEqual(before);
  }, 30_000);
});
