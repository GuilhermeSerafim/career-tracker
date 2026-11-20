import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildSnapshot, validateSnapshot } from '../../domain/export';
import { instantNanoseconds } from '../../domain/dates';
import type { Command } from '../../shared/commands';
import { unknownDate } from '../fixtures/career';
import { seedReview } from '../helpers/review-scenario';
import { syntheticCareerApi } from '../helpers/synthetic-career';
import { connectTestDatabase } from '../helpers/database';

let api: Awaited<ReturnType<typeof syntheticCareerApi>>;
beforeEach(async () => { api = await syntheticCareerApi(); });
afterEach(async () => { await api?.close(); });

const evidence = () => ({ clientId: randomUUID(), kind: 'relato_usuario' as const, originalText: 'Evidência fictícia.', source: null, occurredDate: null, privateRef: null, localRef: null });
type EventInput = Extract<Command, { operation: 'record_event' }>['data'];
const occurrence = { precision: 'day', certainty: 'exact', value: '2024-10-11' } as const;
const assessment = (resultText: string): EventInput => ({ kind: 'avaliacao', state: 'concluido', occurredDate: unknownDate, resultText, scoreValue: null, scoreUnit: null, sourceText: null, evidence: evidence() });
const read = (url: string) => api.request(`/api/v1/${url}`, { headers: api.headers });
const ref = (row: { id: string; version: number }) => ({ id: row.id, expectedVersion: row.version });

async function historical(company: string) {
  const result = await api.post({
    operation: 'save_application', clientId: randomUUID(), evidence: evidence(),
    data: { opportunity: { company, title: 'Engenharia', kind: 'vaga', platform: null, tenant: null, jobCode: null, jobKey: null, seniority: null, modality: null, description: null, stack: [], identities: [] }, track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: unknownDate, stage: 'desconhecida', cycleRelation: 'before_reset', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [], links: [] },
  });
  expect(result.status).toBe(201);
  return result.json.application;
}
async function record(row: { id: string; version: number }, data: ReturnType<typeof assessment>) {
  const result = await api.post({ operation: 'record_event', clientId: randomUUID(), application: ref(row), data });
  expect(result.status).toBe(201);
  return { event: result.json.event, application: result.json.parents.application };
}
async function correctToNote(result: Awaited<ReturnType<typeof record>>) {
  const corrected = await api.post({ operation: 'correct_event', clientId: randomUUID(), application: ref(result.application), eventId: result.event.id, replacement: { ...assessment('Nota fictícia'), kind: 'nota', state: 'informado', evidence: null }, reason: 'Registro não era uma avaliação.', evidence: evidence() });
  expect(corrected.status).toBe(201);
  return corrected.json;
}
async function batch() {
  const list = await read('batches');
  expect(list.status).toBe(200);
  return list.json.items[0];
}
async function close() {
  const result = await api.post({ operation: 'close_review', batch: ref(await batch()), narrative: 'Balanço fictício.', decisions: [] });
  expect(result.status).toBe(201);
  return result.json.reviewId as string;
}
async function rectify(predecessorId: string) {
  const result = await api.post({ operation: 'revise_review', batch: ref(await batch()), predecessorId, type: 'rectification', reason: 'Atualizar interpretação com nova evidência.', evidence: evidence(), narrative: null, decisions: [] });
  expect(result.status).toBe(201);
  return result.json.reviewId as string;
}

it('omits superseded external assessments at close and rectification while freezing the earlier declared result', async () => {
  await seedReview(api);
  const obsolete = await record(await historical('Processo anterior corrigido'), assessment('Avaliação substituída antes do fechamento.'));
  const priorCorrection = await correctToNote(obsolete);
  const active = await record(priorCorrection.parents.application, assessment('Avaliação vigente no primeiro fechamento.'));
  const concurrent = await connectTestDatabase();
  const lateId = randomUUID();
  let originalId: string;
  let lateRecordedAt: string;
  try {
    await concurrent.query('BEGIN');
    const late = await concurrent.query<{ recorded_at: string }>(`INSERT INTO career.events(id,owner_id,application_id,kind,state,supersedes_event_id)
      VALUES($1,$2,$3,'nota','informado',$4) RETURNING to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at`,
    [lateId, api.owner, active.application.id, active.event.id]);
    lateRecordedAt = late.rows[0]!.recorded_at;
    originalId = await close();
    await concurrent.query('COMMIT');
  } finally { await concurrent.end(); }
  const original = (await read(`reviews/${originalId}`)).json;
  expect(instantNanoseconds(lateRecordedAt)).toBeLessThan(instantNanoseconds(original.version.snapshot.asOf));
  expect(original.externalResults.map((event: { id: string }) => event.id)).toEqual([active.event.id]);
  expect(original.version.snapshot.externalResultApplicationIds).toEqual([active.application.id]);
  expect(original.version.snapshot.metrics.assessment).toMatchObject({ numerator: 0, denominator: 30 });
  const exported = await read('exports?format=json');
  expect(exported.status).toBe(200);
  const { entities } = validateSnapshot(exported.json);
  expect(entities.some((row) => row.table === 'events' && row.data.id === lateId)).toBe(true);
  const injected = entities.map((row) => row.table === 'review_versions' && row.data.id === originalId
    ? { ...row, data: { ...row.data, snapshot: { ...row.data.snapshot, externalResultEventIds: [active.event.id, obsolete.event.id].sort() } } }
    : row);
  expect(() => buildSnapshot(api.owner, injected)).toThrow();
  expect(original.version.snapshot.externalEventHistoryIds).toEqual(expect.arrayContaining([obsolete.event.id, priorCorrection.event.id, active.event.id]));
  expect(original.version.snapshot.externalEventHistoryIds).not.toContain(lateId);
  const originalMarkdown = await read(`reviews/${originalId}?format=markdown`);
  expect(originalMarkdown.status).toBe(200);
  const externalMarkdown = originalMarkdown.text.split('## Resultados históricos externos')[1]!.split('## Snapshot e proveniência privados')[0]!;
  expect(externalMarkdown).toContain(active.event.id);
  expect(externalMarkdown).not.toContain(obsolete.event.id);

  const nextId = await rectify(originalId);
  const next = (await read(`reviews/${nextId}`)).json;
  expect(next.externalResults).toEqual([]);
  expect(next.version.snapshot.externalEventHistoryIds).toContain(lateId);
  expect((await read(`reviews/${originalId}`)).json).toEqual(original);
  expect((await read(`reviews/${originalId}?format=markdown`)).text).toBe(originalMarkdown.text);
}, 45_000);

it('captures an uncaptured alias outcome under its canonical member and keeps later knowledge separate', async () => {
  const members = await seedReview(api);
  const member = members[0];
  const alias = await historical('Alias anterior ao ciclo');
  const assessed = await record(alias, assessment('Avaliação que pertence à candidatura canônica.'));
  const second = await record(assessed.application, assessment('Outra avaliação da mesma candidatura.'));
  const resolved = await api.post({
    operation: 'resolve_duplicate', application: ref(second.application), canonicalApplication: ref(member), affectedBatches: [ref(await batch())], reason: 'Identidade duplicada comprovada.', evidence: evidence(),
  });
  expect(resolved.status).toBe(200);
  const corrected = await correctToNote({ event: assessed.event, application: resolved.json.application });
  const originalId = await close();
  const original = (await read(`reviews/${originalId}`)).json;
  expect([...original.version.populationIds].sort()).toEqual(members.map((item) => item.id).sort());
  expect(original.version.snapshot.metrics.assessment).toMatchObject({ numerator: 1, denominator: 30, applicationIds: [member.id] });
  expect(original.version.eventIds).toContain(assessed.event.id);
  expect(original.version.eventIds).toContain(second.event.id);
  expect(original.version.snapshot.events).toContainEqual(expect.objectContaining({ id: assessed.event.id, applicationId: alias.id }));
  expect(original.version.snapshot.events).toContainEqual(expect.objectContaining({ id: corrected.event.id, applicationId: alias.id, kind: 'nota', state: 'informado', supersedesEventId: assessed.event.id }));
  expect(original.version.snapshot.eventEvidence).toContainEqual(expect.objectContaining({ eventId: assessed.event.id }));
  expect(original.externalResults).toEqual([]);
  expect(original.laterResults).toEqual([]);

  // The date of occurrence is older, but this outcome was first recorded after the close.
  const later = await record(corrected.parents.application, { ...assessment('Entrevista registrada depois.'), kind: 'entrevista', occurredDate: occurrence });
  expect((await read(`reviews/${originalId}`)).json.laterResults).toEqual([
    expect.objectContaining({ id: later.event.id, canonicalApplicationId: member.id }),
  ]);
  const nextId = await rectify(originalId);
  const next = (await read(`reviews/${nextId}`)).json;
  expect(next.version.populationIds).toEqual(original.version.populationIds);
  expect(next.version.snapshot.metrics.assessment).toEqual(original.version.snapshot.metrics.assessment);
  expect(next.version.snapshot.metrics.interview).toMatchObject({ numerator: 1, denominator: 30, applicationIds: [member.id] });
  expect(next.version.eventIds).toContain(later.event.id);
  expect(next.laterResults).toEqual([]);
  expect((await read(`reviews/${originalId}`)).json.version).toEqual(original.version);

  const exported = await read('exports?format=json');
  expect(exported.status).toBe(200);
  const snapshot = validateSnapshot(exported.json);
  const review = snapshot.entities.find((row) => row.table === 'review_versions' && row.data.id === nextId);
  expect(review?.data).toEqual(next.version);
  const withoutAliasProvenance = snapshot.entities.map((row) => row.table === 'review_versions' && row.data.id === nextId
    ? { ...row, data: { ...row.data, snapshot: { ...row.data.snapshot, relatedCanonicalApplications: [] } } }
    : row);
  expect(() => buildSnapshot(api.owner, withoutAliasProvenance)).toThrow();
  const markdown = await read(`reviews/${nextId}?format=markdown`);
  expect(markdown.status).toBe(200);
  expect(markdown.text).toContain(assessed.event.id);
  expect(markdown.text).toContain(alias.id);
}, 45_000);
