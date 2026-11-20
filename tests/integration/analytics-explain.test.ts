import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { syntheticCareerApi } from '../helpers/synthetic-career';
import { connectTestDatabase } from '../helpers/database';
import type { AnalyticsResponse } from '../../shared/analytics';
let fixture: Awaited<ReturnType<typeof syntheticCareerApi>>;
const ids = Array.from({ length: 306 }, () => randomUUID());
const query = { operation: 'metrics', period: { from: '2026-11-01', to: '2026-11-17' }, population: 'confirmed', dimension: 'batch', submissionScope: 'all_dates' };
const day = { precision: 'day', certainty: 'exact', value: '2026-11-10' };
let result: AnalyticsResponse;
const request = (explain: unknown, extra: Record<string, string> = {}, headers?: Record<string, string>) => fixture.request(`/api/v1/applications?${new URLSearchParams({ query: JSON.stringify(result.query), explain: JSON.stringify(explain), limit: '100', ...extra })}`, { headers: headers ?? fixture.headers });
beforeAll(async () => {
  fixture = await syntheticCareerApi(); const admin = await connectTestDatabase();
  try {
    const opportunity = randomUUID();
    await admin.query('INSERT INTO career.opportunities(id,owner_id,company) VALUES($1,$2,$3)', [opportunity, fixture.owner, 'Analytics synthetic']);
    const rows = ids.map((id, index) => ({ id, n: index + 1, date: index >= 202 && index < 303 ? { precision: 'unknown', value: null } : index === 305 ? { precision: 'month', certainty: 'approximate', value: '2026-11' } : day }));
    await admin.query(`INSERT INTO career.applications(id,owner_id,opportunity_id,display_id,application_instance,submission_status,submitted_date,archived_at) SELECT (r->>'id')::uuid,$1,$2,'N'||lpad(r->>'n',6,'0'),r->>'n','confirmado',(r->'date')::career.date_value,CASE WHEN r->>'n'='1' THEN now() ELSE NULL END FROM jsonb_array_elements($3::jsonb) r`, [fixture.owner, opportunity, JSON.stringify(rows)]);
    await admin.query('UPDATE career.applications SET discovery_channel=$3 WHERE owner_id=$1 AND id=$2', [fixture.owner, ids[0], 'L'.repeat(300)]);
    const resume = randomUUID();
    await admin.query('INSERT INTO career.resume_refs(id,owner_id,label) VALUES($1,$2,$3)', [resume, fixture.owner, 'Synthetic sent CV']);
    await admin.query('INSERT INTO career.application_resumes(owner_id,application_id,resume_id) SELECT $1,unnest($2::uuid[]),$3', [fixture.owner, ids.slice(0, 205), resume]);
    const events = [...ids.slice(0, 101).map((id) => ({ id, date: { ...day, value: '2026-11-12' } })), { id: ids[303], date: { precision: 'unknown', value: null } }, { id: ids[304], date: { ...day, value: '2026-11-09' } }];
    await admin.query(`INSERT INTO career.events(owner_id,application_id,kind,state,occurred_date) SELECT $1,(r->>'id')::uuid,'retorno_substantivo','informado',(r->'date')::career.date_value FROM jsonb_array_elements($2::jsonb) r`, [fixture.owner, JSON.stringify(events)]);
  } finally { await admin.end(); }
  const response = await fixture.request(`/api/v1/analytics?${new URLSearchParams({ query: JSON.stringify(query) })}`, { headers: fixture.headers });
  expect(response.status).toBe(200); result = response.json as unknown as AnalyticsResponse;
});
afterAll(async () => { await fixture?.close(); });
async function all(explain: unknown, expected: readonly string[]) {
  let cursor: string | null = null; const found: string[] = []; let pages = 0;
  do {
    const response = await request(explain, cursor ? { cursor } : {});
    expect(response.status).toBe(200); expect(response.json.total).toBe(expected.length);
    found.push(...response.json.items.map((item: { id: string }) => item.id));
    cursor = response.json.nextCursor; pages++;
  } while (cursor);
  expect(found.length).toBe(new Set(found).size); expect([...found].sort()).toEqual([...expected].sort());
  return pages;
}
it('explains >100 eligible cases without a raw-ID URL', async () => {
  expect(result.firstReturn.eligibleN).toBe(101); expect(result.firstReturn.medianDays).toBe(2);
  expect(await all({ kind: 'firstReturn', selection: 'eligible' }, ids.slice(0, 101))).toBe(2);
});
it('explains >100 distribution cases with exact IDs', async () => {
  expect(await all({ kind: 'firstReturnDistribution', days: 2 }, result.firstReturn.distribution[0]!.applicationIds)).toBe(2);
});
it('explains >100 cases excluded for no recorded response', async () => {
  expect(await all({ kind: 'firstReturnExclusion', reason: 'no_recorded_response' }, ids.slice(101, 202))).toBe(2);
});
it('explains >100 cases excluded for imprecise submission', async () => {
  expect(await all({ kind: 'firstReturnExclusion', reason: 'imprecise_submission' }, [...ids.slice(202, 303), ids[305]!])).toBe(2);
});
it('explains indeterminate and contradictory return exclusions', async () => {
  await all({ kind: 'firstReturnExclusion', reason: 'uncertain_response' }, [ids[303]!]);
  await all({ kind: 'firstReturnExclusion', reason: 'response_before_submission' }, [ids[304]!]);
});
it('explains >100 unknown precision cases and absent valid buckets', async () => {
  expect(await all({ kind: 'coverage', collection: 'precision', key: 'unknown' }, ids.slice(202, 303))).toBe(2);
  await all({ kind: 'coverage', collection: 'certainty', key: 'approximate' }, [ids[305]!]);
  await all({ kind: 'coverage', collection: 'precision', key: 'year' }, []);
  await all({ kind: 'firstReturnDistribution', days: 99 }, []);
});
it('explains 101 missing-CV cases across two pages without auditing reads', async () => {
  const audit = await fixture.auditCount();
  expect(await all({ kind: 'coverage', collection: 'missing', key: 'sentCv' }, ids.slice(205))).toBe(2);
  expect(await fixture.auditCount()).toBe(audit);
});
it('rejects malformed and prototype selectors, inconsistent coverage and unauthorized owners', async () => {
  const invalid = [
    { kind: 'firstReturn', selection: 'other' }, { kind: 'firstReturn', selection: 'eligible', key: 'x' },
    { kind: 'firstReturnDistribution', days: -1 }, { kind: 'firstReturnDistribution', days: 1.5 }, { kind: 'firstReturnDistribution', days: '2' },
    { kind: 'firstReturnExclusion', reason: '__proto__' }, { kind: 'firstReturnExclusion', reason: 'constructor' },
    { kind: 'coverage', collection: 'precision', key: 'constructor' }, { kind: 'coverage', collection: 'certainty', key: 'day' },
    { kind: 'coverage', collection: 'precision', key: 'sentCv' }, { kind: 'coverage', collection: 'missing', key: 'unknown' },
    JSON.parse('{"kind":"coverage","collection":"missing","key":"sentCv","__proto__":{}}'),
  ];
  for (const explain of invalid) expect((await request(explain)).status).toBe(400);
  expect((await request({ kind: 'coverage', collection: 'missing', key: 'sentCv' }, {}, {})).status).toBe(401);
  expect((await request({ kind: 'firstReturn', selection: 'eligible' }, {}, { authorization: 'Bearer other.payload.signature' })).status).toBe(403);
  const admin = await connectTestDatabase(); const foreign = randomUUID(); const opportunity = randomUUID();
  try {
    await admin.query('INSERT INTO career.opportunities(id,owner_id) VALUES($1,$2)', [opportunity, foreign]);
    await admin.query("INSERT INTO career.applications(owner_id,opportunity_id,display_id,submission_status) VALUES($1,$2,'N999999','confirmado')", [foreign, opportunity]);
    await all({ kind: 'coverage', collection: 'missing', key: 'sentCv' }, ids.slice(205));
  } finally { await admin.query('DELETE FROM career.applications WHERE owner_id=$1', [foreign]); await admin.query('DELETE FROM career.opportunities WHERE owner_id=$1', [foreign]); await admin.end(); }
});
it('refuses restrictive intersections for all explain requests and binds cursors to exact derived IDs', async () => {
  const explain = { kind: 'population', name: 'allConfirmed' };
  for (const extra of ([{ search: 'Analytics' }, { view: 'confirmed' }, { view: 'saved' }, { filters: JSON.stringify({ archived: 'exclude' }) }] as Record<string, string>[])) expect((await request(explain, extra)).status).toBe(400);
  const first = await request({ kind: 'firstReturn', selection: 'eligible' }); expect(first.status).toBe(200); expect(first.json.nextCursor).toBeTruthy();
  expect((await request({ kind: 'coverage', collection: 'missing', key: 'sentCv' }, { cursor: first.json.nextCursor })).status).toBe(400);
  expect((await request({ kind: 'firstReturn', selection: 'eligible' }, { cursor: 'invalid' })).status).toBe(400);
  // Live query selectors retain recorded knowledge but current business metadata can change.
  const admin = await connectTestDatabase();
  try { await admin.query('UPDATE career.applications SET counting_eligible=false WHERE owner_id=$1 AND id=$2', [fixture.owner, ids[1]]); }
  finally { await admin.end(); }
  expect((await request({ kind: 'firstReturn', selection: 'eligible' }, { cursor: first.json.nextCursor })).status).toBe(400);
});

it('keeps equal completed and events-period counts attached to their distinct exact IDs', async () => {
  const admin = await connectTestDatabase(); const opportunity = randomUUID(); const a = randomUUID(); const b = randomUUID();
  try {
    await admin.query('INSERT INTO career.opportunities(id,owner_id,company) VALUES($1,$2,$3)', [opportunity, fixture.owner, 'Separate populations']);
    await admin.query(`INSERT INTO career.applications(id,owner_id,opportunity_id,display_id,application_instance,submission_status,submitted_date) VALUES($1,$3,$4,'N999991','one','confirmado',$5),($2,$3,$4,'N999992','two','confirmado',$6)`, [a,b,fixture.owner,opportunity,day,{ ...day, value: '2025-01-01' }]);
    await admin.query(`INSERT INTO career.events(owner_id,application_id,kind,state,occurred_date) VALUES($1,$2,'entrevista','concluido',$4),($1,$3,'entrevista','agendado',$5)`, [fixture.owner,a,b,{ ...day, value: '2026-12-01' },{ ...day, value: '2026-11-12' }]);
    await admin.query(`INSERT INTO career.events(owner_id,application_id,kind,state,occurred_date) VALUES($1,$2,'retorno_substantivo','informado',$4),($1,$3,'avaliacao','convidado',$4)`, [fixture.owner,a,b,{ ...day, value: '2026-11-12' }]);
  } finally { await admin.end(); }
  const response = await fixture.request(`/api/v1/analytics?${new URLSearchParams({ query: JSON.stringify({ ...query, submissionScope: 'submitted_in_period', filters: { company: ['Separate populations'] } }) })}`, { headers: fixture.headers });
  expect(response.status).toBe(200); const original = result; result = response.json as unknown as AnalyticsResponse;
  try {
    expect(result.conversions.interview.applicationIds).toEqual([a]);
    expect(result.completed.interview.applicationIds).toEqual([a]);
    expect(result.eventsInPeriod.categories.interview.applicationIds).toEqual([b]);
    await all({ kind: 'completed', category: 'interview' }, [a]);
    await all({ kind: 'eventsCategory', category: 'interview' }, [b]);
    await all({ kind: 'completed', category: 'offer' }, []);
    await all({ kind: 'eventsCategory', category: 'offer' }, []);
    await all({ kind: 'group', collection: 'discoveryChannel', key: 'canal_desconhecido', isMissing: true }, [a]);
    await all({ kind: 'group', collection: 'discoveryChannel', key: 'canal_desconhecido', isMissing: true, category: 'interview' }, [a]);
    for (const kind of ['completed', 'eventsCategory']) for (const category of ['__proto__', 'constructor', 'other']) expect((await request({ kind, category })).status).toBe(400);
    expect((await request({ kind: 'group', collection: 'discoveryChannel', key: 'canal_desconhecido', isMissing: true, category: 'other' })).status).toBe(400);
    const allDates = await fixture.request(`/api/v1/analytics?${new URLSearchParams({ query: JSON.stringify({ ...result.query, submissionScope: 'all_dates' }) })}`, { headers: fixture.headers });
    expect(allDates.status).toBe(200); result = allDates.json as unknown as AnalyticsResponse;
    const group = result.groups.discoveryChannel[0]!;
    expect(group.conversions.response).toMatchObject({ numerator: 1, denominator: 2, applicationIds: [a] });
    expect(group.conversions.assessment).toMatchObject({ numerator: 1, denominator: 2, applicationIds: [b] });
    await all({ kind: 'group', collection: 'discoveryChannel', key: group.key, isMissing: true }, [a,b]);
    await all({ kind: 'group', collection: 'discoveryChannel', key: group.key, isMissing: true, category: 'response' }, [a]);
    await all({ kind: 'group', collection: 'discoveryChannel', key: group.key, isMissing: true, category: 'assessment' }, [b]);
  } finally { result = original; }
});

it('explains effective occurrence-date buckets in event units through exact filtered application lists', async () => {
  const admin = await connectTestDatabase();
  const opportunity = randomUUID(), a = randomUUID(), b = randomUUID();
  const undated = { precision: 'unknown', value: null };
  const predecessor = randomUUID(), known = randomUUID();
  try {
    await admin.query('INSERT INTO career.opportunities(id,owner_id,company) VALUES($1,$2,$3)', [opportunity, fixture.owner, 'Occurrence coverage']);
    await admin.query(`INSERT INTO career.applications(id,owner_id,opportunity_id,display_id,application_instance,submission_status,submitted_date) VALUES($1,$3,$4,'N999993','one','confirmado',$5),($2,$3,$4,'N999994','two','confirmado',$5)`, [a, b, fixture.owner, opportunity, day]);
    await admin.query(`INSERT INTO career.events(owner_id,application_id,kind,state,occurred_date) VALUES($1,$2,'avaliacao','concluido',$4),($1,$2,'entrevista','concluido',$4),($1,$3,'nota','informado',$5)`, [fixture.owner, a, b, undated, { precision: 'month', certainty: 'exact', value: '2026-11' }]);
    await admin.query(`INSERT INTO career.events(id,owner_id,application_id,kind,state,occurred_date) VALUES($1,$2,$3,'avaliacao','concluido',$4)`, [predecessor, fixture.owner, b, undated]);
    await admin.query(`INSERT INTO career.events(id,owner_id,application_id,kind,state,occurred_date,supersedes_event_id) VALUES($1,$2,$3,'nota','informado',$4,$5)`, [known, fixture.owner, b, day, predecessor]);
  } finally { await admin.end(); }
  const response = await fixture.request(`/api/v1/analytics?${new URLSearchParams({ query: JSON.stringify({ ...query, filters: { company: ['Occurrence coverage'] } }) })}`, { headers: fixture.headers });
  expect(response.status).toBe(200);
  const original = result;
  result = response.json as unknown as AnalyticsResponse;
  try {
    await all({ kind: 'occurrenceDateCoverage', bucket: 'unknown', selectionKey: result.occurrenceDateDrilldown.unknown }, [a]);
    await all({ kind: 'occurrenceDateCoverage', bucket: 'imprecise', selectionKey: result.occurrenceDateDrilldown.imprecise }, [b]);
    await all({ kind: 'occurrenceDateCoverage', bucket: 'exactDay', selectionKey: result.occurrenceDateDrilldown.exactDay }, [b]);
    expect((await request({ kind: 'occurrenceDateCoverage', bucket: 'unknown' })).status).toBe(409);
    expect((await request({ kind: 'occurrenceDateCoverage', bucket: 'unknown', selectionKey: result.occurrenceDateDrilldown.imprecise })).status).toBe(409);
    expect((await request({ kind: 'occurrenceDateCoverage', bucket: 'unknown', selectionKey: 'invalid' })).status).toBe(400);
    expect((await request({ kind: 'occurrenceDateCoverage', bucket: 'constructor' })).status).toBe(400);
    expect(result.occurrenceDateCoverage).toMatchObject({ unit: 'event', denominator: 4, buckets: { unknown: { eventCount: 2 }, imprecise: { eventCount: 1 }, exactDay: { eventCount: 1 } } });
    expect(result.completed.assessment.applicationIds).toEqual([a]);
    expect(result.eventsInPeriod.eventIds).toEqual([known]);
  } finally { result = original; }
});

it('withholds stale occurrence membership after a company edit and explains the recalculated bucket', async () => {
  const admin = await connectTestDatabase();
  const company = 'Fictional exact coverage filter';
  const opportunity = randomUUID(), application = randomUUID();
  const readMetrics = () => fixture.request(`/api/v1/analytics?${new URLSearchParams({ query: JSON.stringify({ ...query, filters: { company: [company] } }) })}`, { headers: fixture.headers });
  const explainUnknown = (data: Record<string, unknown>) => {
    const keys = data.occurrenceDateDrilldown as { unknown: string } | undefined;
    return fixture.request(`/api/v1/applications?${new URLSearchParams({
      query: JSON.stringify(data.query),
      explain: JSON.stringify({ kind: 'occurrenceDateCoverage', bucket: 'unknown', selectionKey: keys?.unknown }),
    })}`, { headers: fixture.headers });
  };
  try {
    await admin.query('INSERT INTO career.opportunities(id,owner_id,company) VALUES($1,$2,$3)', [opportunity, fixture.owner, company]);
    await admin.query("INSERT INTO career.applications(id,owner_id,opportunity_id,display_id,submission_status) VALUES($1,$2,$3,'N999995','confirmado')", [application, fixture.owner, opportunity]);
    await admin.query("INSERT INTO career.events(owner_id,application_id,kind,state) VALUES($1,$2,'avaliacao','concluido')", [fixture.owner, application]);
    const initial = await readMetrics();
    expect(initial.status).toBe(200);
    expect(initial.json.occurrenceDateCoverage.buckets.unknown.applicationIds).toEqual([application]);
    const initialList = await explainUnknown(initial.json);
    expect(initialList.status).toBe(200);
    expect(initialList.json.items.map((row: { id: string }) => row.id)).toEqual([application]);

    await admin.query('UPDATE career.opportunities SET company=$1 WHERE id=$2', ['Fictional edited company', opportunity]);
    const stale = await explainUnknown(initial.json);
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('ANALYTICS_SELECTION_STALE');
    expect(stale.json.items).toBeUndefined();

    const fresh = await readMetrics();
    expect(fresh.status).toBe(200);
    expect(fresh.json.query.filters).toEqual(initial.json.query.filters);
    expect(fresh.json.asOf).not.toBe(initial.json.asOf);
    expect(fresh.json.occurrenceDateDrilldown.unknown).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.json.occurrenceDateCoverage.buckets.unknown).toEqual({ eventCount: 0, applicationIds: [] });
    const freshList = await explainUnknown(fresh.json);
    expect(freshList.status).toBe(200);
    expect(freshList.json).toMatchObject({ items: [], total: 0 });
  } finally { await admin.end(); }
});

it('explains exact group keys above 200 characters and rejects above the domain maximum', async () => {
  await all({ kind: 'group', collection: 'discoveryChannel', key: 'L'.repeat(300), isMissing: false }, [ids[0]!]);
  expect((await request({ kind: 'group', collection: 'discoveryChannel', key: 'L'.repeat(501), isMissing: false })).status).toBe(400);
});
