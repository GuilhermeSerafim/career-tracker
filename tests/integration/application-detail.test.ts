import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { syntheticCareerApi } from '../helpers/synthetic-career';
import { seedToday } from '../helpers/today-scenario';
import { connectTestDatabase } from '../helpers/database';
let fixture: Awaited<ReturnType<typeof syntheticCareerApi>>;
beforeAll(async () => { fixture = await syntheticCareerApi(); });
afterAll(async () => { await fixture?.close(); });
const proof = () => ({ clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Correção fictícia conferida.', source: null, occurredDate: null, privateRef: null, localRef: null });
it('reads exact physical batch versions and guards correction against an intervening batch update', async () => {
  const scenario = await seedToday(fixture);
  const read = (id: string) => fixture.request(`/api/v1/applications/${id}`, { headers: fixture.headers });
  const list = await fixture.request('/api/v1/applications?view=all&limit=100', { headers: fixture.headers });
  const unknown = list.json.items.find((a: { opportunity: { company: string } }) => a.opportunity.company === 'Empresa sem data');
  const other = list.json.items.find((a: { opportunity: { company: string } }) => a.opportunity.company === 'Empresa de ontem');
  const empty = await read(unknown.id);
  expect(empty.json.affectedBatches).toEqual([]);
  const current = await read(scenario.applicationId);
  const batches = await fixture.request('/api/v1/batches?limit=100', { headers: fixture.headers });
  expect(current.json.affectedBatches).toEqual([{ id: batches.json.items[0].id, version: batches.json.items[0].version, status: 'open' }]);
  const before = await fixture.auditCount();
  expect((await read(scenario.applicationId)).json.affectedBatches).toEqual(current.json.affectedBatches);
  expect(await fixture.auditCount()).toBe(before);
  expect((await fixture.request(`/api/v1/applications/${scenario.applicationId}`, { headers: { authorization: 'Bearer other.payload.signature' } })).status).toBe(403);
  const ref = (a: { id: string; version: number }) => ({ id: a.id, expectedVersion: a.version });
  const otherDetail = await read(other.id);
  expect((await fixture.post({ operation: 'update_application', application: ref(other), changes: {}, reconciliation: { submittedDate: other.submittedDate, cycleRelation: 'before_reset' }, affectedBatches: otherDetail.json.affectedBatches.map(ref), evidence: proof() })).status).toBe(200);
  const correction = { operation: 'invalidate_submission', application: ref(current.json.application), affectedBatches: current.json.affectedBatches.map(ref), reason: 'Envio fictício invalidado.', evidence: proof() };
  expect((await fixture.post(correction)).status).toBe(409);
  const fresh = await read(scenario.applicationId);
  expect(fresh.json.application.version).toBe(current.json.application.version);
  expect(fresh.json.affectedBatches[0].version).toBeGreaterThan(current.json.affectedBatches[0].version);
  expect((await fixture.post({ ...correction, affectedBatches: fresh.json.affectedBatches.map(ref) })).status).toBe(200);
  const source = (await read(scenario.applicationId)).json;
  expect((await fixture.post({ operation: 'resolve_duplicate', application: ref(source.application), canonicalApplication: ref(empty.json.application), affectedBatches: source.affectedBatches.map(ref), reason: 'Mesmo envio fictício após conferência.', evidence: proof() })).status).toBe(200);
  const canonical = (await read(unknown.id)).json;
  expect(canonical.application.historyApplicationIds).toContain(scenario.applicationId);
  expect(canonical.affectedBatches).toEqual([]);
  expect((await read(scenario.applicationId)).json.affectedBatches).toHaveLength(1);

  const admin = await connectTestDatabase(); const foreign = randomUUID();
  const opportunity = randomUUID(); const application = randomUUID(); const cycle = randomUUID(); const batch = randomUUID();
  try {
    await admin.query('INSERT INTO career.opportunities(id,owner_id) VALUES($1,$2)', [opportunity, foreign]);
    await admin.query('INSERT INTO career.applications(id,owner_id,opportunity_id) VALUES($1,$2,$3)', [application, foreign, opportunity]);
    await admin.query('INSERT INTO career.cycles(id,owner_id) VALUES($1,$2)', [cycle, foreign]);
    await admin.query('INSERT INTO career.batches(id,owner_id,cycle_id,batch_number,version) VALUES($1,$2,$3,1,7)', [batch, foreign, cycle]);
    await admin.query('INSERT INTO career.batch_members(owner_id,batch_id,application_id,captured_order) VALUES($1,$2,$3,1)', [foreign, batch, application]);
    expect((await read(application)).status).toBe(404);
    expect((await read(scenario.applicationId)).json.affectedBatches).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: batch })]));
  } finally {
    for (const table of ['batch_members', 'batches', 'cycles', 'applications', 'opportunities']) await admin.query(`DELETE FROM career.${table} WHERE owner_id=$1`, [foreign]);
    await admin.end();
  }
});
