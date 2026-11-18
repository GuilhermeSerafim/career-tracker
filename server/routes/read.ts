import { readPermission } from '../agent-policy.js';
import { credentialMetadata, credentialProjection } from '../services/credentials.js';
import { z } from 'zod';
import { applicationFiltersSchema } from '../../shared/queries.js';
import {
  analyticsQuerySchema,
  MAX_ANALYTICS_DAYS,
  MAX_ANALYTICS_ENTRIES,
  type AnalyticsResult,
} from '../../shared/analytics.js';
import { instantSchema, localDaySchema, shortTextSchema, uuidSchema } from '../../shared/model.js';
import { buildAnalytics } from '../../domain/metrics.js';
import { buildReviewSnapshot } from '../../domain/cycles.js';
import { reviewMarkdown } from '../../domain/review-markdown.js';
import { civilDaysBetween, toLocalDay } from '../../domain/dates.js';
import { snapshotCsv, transferHash } from '../../domain/export.js';
import type { createDatabase, RequestContext, Transaction } from '../database';
import type { AuthenticatedActor } from '../auth';
import { SafeError } from '../errors.js';
import { applicationProjection } from '../repositories/career.js';
import { listApplicationEvents, contactProjection } from '../repositories/activity.js';
import { loadReviewProjection } from '../repositories/reviews.js';
import { readSnapshot, transferProjection } from '../repositories/transfers.js';
import { listTodayTasks } from '../services/activity.js';
import { assertRepresentableJson } from '../input.js';

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** A projeção SQL já limita todas as linhas ao proprietário autenticado.
 * Atribuição ao agregado vivo conserva a FK física e recusa cadeias corrompidas. */
function canonicalAttribution(
  rows: readonly { id: string; canonicalApplicationId: string | null }[],
) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id: string) => {
    const seen = new Set<string>();
    let row = byId.get(id);
    while (row?.canonicalApplicationId && !seen.has(row.id)) {
      seen.add(row.id);
      row = byId.get(row.canonicalApplicationId);
    }
    if (!row || row.canonicalApplicationId) throw new SafeError('DATABASE_UNAVAILABLE');
    return row.id;
  };
}
const cursorSchema = z.strictObject({
  createdAt: instantSchema,
  id: uuidSchema,
  scope: z.string().regex(/^[0-9a-f]{64}$/),
});
function decode(value: string): unknown {
  try {
    const result: unknown = JSON.parse(value);
    assertRepresentableJson(result);
    return result;
  } catch {
    throw new SafeError('INVALID_INPUT');
  }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new SafeError('INVALID_INPUT');
  return result.data;
}
function params(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new SafeError('INVALID_INPUT');
  for (const value of url.searchParams.values()) assertRepresentableJson(value);
}
function paging(url: URL, scope: unknown) {
  const limit = parse(
    z.coerce.number().int().min(1).max(100),
    url.searchParams.get('limit') ?? '50',
  );
  let after: z.infer<typeof cursorSchema> | null = null;
  const scopeHash = transferHash(scope);
  const raw = url.searchParams.get('cursor');
  if (raw) {
    if (raw.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new SafeError('INVALID_INPUT');
    after = parse(cursorSchema, decode(Buffer.from(raw, 'base64url').toString('utf8')));
    if (after.scope !== scopeHash) throw new SafeError('INVALID_INPUT');
  }
  return { limit, after, scopeHash };
}
function nextCursor(row: { id: string; createdAt: string } | undefined, scope: string) {
  return row
    ? Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id, scope })).toString(
        'base64url',
      )
    : null;
}
async function settings(tx: Transaction, owner: string) {
  const row = (
    await tx.query<{ id: string; version: number; dailyGoal: number; timezone: string }>(
      'SELECT id,version,daily_goal AS "dailyGoal",timezone FROM career.owner_settings WHERE owner_id=$1',
      [owner],
    )
  ).rows[0];
  if (!row) throw new SafeError('NOT_CONFIGURED');
  return { ...row, integration: { authentication: 'scoped_agent', agentAvailable: true } };
}
async function analytics(tx: Transaction, owner: string, raw: unknown) {
  const projection = await loadReviewProjection(tx, owner, '00000000-0000-4000-8000-000000000000');
  const config = await settings(tx, owner);
  const input = raw && typeof raw === 'object' ? raw : {};
  const query = parse(analyticsQuerySchema, {
    asOf: projection.asOf,
    dailyGoal: config.dailyGoal,
    ...input,
  });
  if (civilDaysBetween(query.period.from, query.period.to) + 1 > MAX_ANALYTICS_DAYS)
    throw new SafeError('INVALID_INPUT');
  if (
    projection.rows.length > MAX_ANALYTICS_ENTRIES ||
    projection.events.length > MAX_ANALYTICS_ENTRIES
  )
    throw new SafeError('PAYLOAD_TOO_LARGE');
  return buildAnalytics(projection.rows, projection.events, query);
}
const explanationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('population'),
    name: z.enum(['selected', 'allConfirmed', 'submissionCohort', 'conversionCohort', 'cycle']),
  }),
  z.strictObject({
    kind: z.literal('conversion'),
    category: z.enum(['response', 'assessment', 'interview', 'offer']),
  }),
  z.strictObject({ kind: z.literal('completed'), category: z.enum(['response', 'assessment', 'interview', 'offer']) }),
  z.strictObject({ kind: z.literal('eventsCategory'), category: z.enum(['response', 'assessment', 'interview', 'offer']) }),
  z.strictObject({
    kind: z.literal('group'),
    collection: z.enum([
      'stack',
      'discoveryChannel',
      'submissionPlatform',
      'sentCv',
      'selectedGrouping',
    ]),
    key: shortTextSchema,
    isMissing: z.boolean(),
    category: z.enum(['response', 'assessment', 'interview', 'offer']).optional(),
  }),
  z.strictObject({ kind: z.literal('eventsInPeriod') }),
  z.strictObject({ kind: z.literal('firstReturn'), selection: z.literal('eligible') }),
  z.strictObject({ kind: z.literal('firstReturnDistribution'), days: z.number().int().nonnegative().max(3_652_058) }),
  z.strictObject({ kind: z.literal('firstReturnExclusion'), reason: z.enum(['imprecise_submission', 'uncertain_response', 'response_before_submission', 'no_recorded_response']) }),
  z.strictObject({ kind: z.literal('coverage'), collection: z.enum(['precision', 'certainty', 'missing']), key: z.string() }).refine(
    ({ collection, key }) => ({ precision: ['unknown', 'day', 'month', 'year', 'instant'], certainty: ['unknown', 'exact', 'approximate'], missing: ['submittedDay', 'sentCv'] })[collection].includes(key),
  ),
  z.strictObject({
    kind: z.literal('series'),
    collection: z.enum(['daily', 'weekly']),
    day: localDaySchema,
  }),
]);
function explainingIds(result: AnalyticsResult, raw: unknown) {
  const selection = parse(explanationSchema, raw);
  if (selection.kind === 'population') return result.populations[selection.name].applicationIds;
  if (selection.kind === 'conversion') return result.conversions[selection.category].applicationIds;
  if (selection.kind === 'completed') return result.completed[selection.category].applicationIds;
  if (selection.kind === 'eventsCategory') return result.eventsInPeriod.categories[selection.category].applicationIds;
  if (selection.kind === 'eventsInPeriod') return result.eventsInPeriod.applicationIds;
  if (selection.kind === 'firstReturn') return result.firstReturn.applicationIds;
  if (selection.kind === 'firstReturnDistribution')
    return result.firstReturn.distribution.find((point) => point.days === selection.days)?.applicationIds ?? [];
  if (selection.kind === 'firstReturnExclusion') return result.firstReturn.exclusions[selection.reason]!.applicationIds;
  if (selection.kind === 'coverage') return result.coverage[selection.collection][selection.key]?.applicationIds ?? [];
  if (selection.kind === 'series')
    return (
      result[selection.collection].find((point) => point.day === selection.day)?.applicationIds ??
      []
    );
  const groups =
    selection.collection === 'selectedGrouping'
      ? result.selectedGrouping.groups
      : result.groups[selection.collection];
  const group = groups.find((group) => group.key === selection.key && group.isMissing === selection.isMissing);
  return (selection.category ? group?.conversions[selection.category].applicationIds : group?.applicationIds) ?? [];
}
async function applications(tx: Transaction, owner: string, url: URL) {
  params(url, ['limit', 'cursor', 'search', 'view', 'filters', 'ids', 'sort', 'query', 'explain']);
  const search = parse(z.string().max(200), url.searchParams.get('search') ?? '');
  const filters = parse(applicationFiltersSchema, decode(url.searchParams.get('filters') ?? '{}'));
  const view = parse(
    z.enum(['confirmed', 'saved', 'unknown', 'all']),
    url.searchParams.get('view') ??
      (url.searchParams.has('query') || url.searchParams.has('ids') ? 'all' : 'confirmed'),
  );
  if (url.searchParams.has('sort') && url.searchParams.get('sort') !== 'createdAt')
    throw new SafeError('INVALID_INPUT');
  let ids: string[] | null = url.searchParams.has('ids')
    ? parse(z.array(uuidSchema).max(100), decode(url.searchParams.get('ids')!))
    : null;
  // IDs de uma análise são uma população fixa; filtros atuais não a reinterpretam.
  if (ids && (search || Object.keys(filters).length || view !== 'all'))
    throw new SafeError('INVALID_INPUT');
  if (url.searchParams.has('query')) {
    if (ids || !url.searchParams.has('explain')) throw new SafeError('INVALID_INPUT');
    ids = explainingIds(
      await analytics(tx, owner, decode(url.searchParams.get('query')!)),
      decode(url.searchParams.get('explain')!),
    );
  } else if (url.searchParams.has('explain')) throw new SafeError('INVALID_INPUT');
  if (ids && (search || Object.keys(filters).length || view !== 'all'))
    throw new SafeError('INVALID_INPUT');
  const scope = { path: 'applications', search, filters, view, ids };
  const page = paging(url, scope);
  const values: unknown[] = [owner];
  const predicates = ['a.owner_id=$1'];
  const bind = (value: unknown) => {
    values.push(value);
    return '$' + values.length;
  };
  if (view !== 'all')
    predicates.push(
      `a.submission_status=${bind({ confirmed: 'confirmado', saved: 'nao_enviado', unknown: 'nao_confirmado' }[view])}`,
    );
  if (view === 'confirmed')
    predicates.push('a.counting_eligible AND a.canonical_application_id IS NULL');
  if (search)
    predicates.push(
      `strpos(lower(concat_ws(' ',o.company,o.title,a.display_id,a.notes)),lower(${bind(search)}))>0`,
    );
  if (ids) predicates.push(`a.id=ANY(${bind(ids)}::uuid[])`);
  const columns = {
    company: 'o.company',
    title: 'o.title',
    seniority: 'o.seniority',
    modality: 'o.modality',
    channel: 'a.discovery_channel',
    platform: 'a.submission_platform',
    status: 'a.submission_status',
    stage: 'a.stage',
  } as const;
  for (const key of Object.keys(columns) as (keyof typeof columns)[])
    if (filters[key]) predicates.push(`${columns[key]}=ANY(${bind(filters[key])}::text[])`);
  if (filters.stack) predicates.push(`o.stack && ${bind(filters.stack)}::text[]`);
  if (filters.batch)
    predicates.push(
      `EXISTS(SELECT 1 FROM career.batch_members m WHERE m.owner_id=a.owner_id AND m.application_id=a.id AND m.batch_id=ANY(${bind(filters.batch)}::uuid[]))`,
    );
  if (filters.archived === 'exclude' || (!filters.archived && !ids))
    predicates.push('a.archived_at IS NULL');
  if (filters.archived === 'only') predicates.push('a.archived_at IS NOT NULL');
  const cursor = page.after
    ? `(created_at,id)>(${bind(page.after.createdAt)}::timestamptz,${bind(page.after.id)}::uuid)`
    : 'true';
  const limit = bind(page.limit + 1);
  const result = await tx.query<{ total: number; rows: { id: string; createdAt: string }[] }>(
    `WITH filtered AS MATERIALIZED (
    SELECT a.id,a.created_at FROM career.applications a JOIN career.opportunities o ON o.owner_id=a.owner_id AND o.id=a.opportunity_id WHERE ${predicates.join(' AND ')}),
    page AS (SELECT id,created_at FROM filtered WHERE ${cursor} ORDER BY created_at,id LIMIT ${limit})
    SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'createdAt',${timestamp('created_at')}) ORDER BY created_at,id) FROM page),'[]') AS rows`,
    values,
  );
  const data = result.rows[0]!;
  const hasNext = data.rows.length > page.limit;
  const rows = data.rows.slice(0, page.limit);
  const items = [];
  for (const row of rows)
    items.push({ ...(await applicationProjection(tx, owner, row.id)), createdAt: row.createdAt });
  return {
    items,
    total: data.total,
    nextCursor: hasNext ? nextCursor(rows.at(-1), page.scopeHash) : null,
    filters,
    view,
  };
}

async function detail(tx: Transaction, owner: string, id: string) {
  const application = await applicationProjection(tx, owner, id);
  const events = await listApplicationEvents(tx, owner, id);
  const history = application.historyApplicationIds;
  const links = (
    await tx.query(
      `SELECT id,contact_id AS "contactId",original_url AS "originalUrl",kind,is_local AS "isLocal",is_private AS "isPrivate" FROM career.links WHERE owner_id=$1 AND (application_id=ANY($2::uuid[]) OR opportunity_id IN (SELECT opportunity_id FROM career.applications WHERE owner_id=$1 AND id=ANY($2::uuid[]))) ORDER BY created_at,id`,
      [owner, history],
    )
  ).rows;
  const evidence = (
    await tx.query(
      `SELECT id,kind,original_text AS "originalText",source,occurred_date AS "occurredDate",private_ref AS "privateRef",local_ref AS "localRef" FROM career.evidence WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY created_at,id`,
      [owner, events.map((event) => event.evidenceId).filter(Boolean)],
    )
  ).rows;
  const tasks = (
    await tx.query(
      `SELECT ${transferProjection('tasks')} AS data FROM career.tasks t WHERE owner_id=$1 AND application_id=ANY($2::uuid[]) ORDER BY created_at,id`,
      [owner, history],
    )
  ).rows.map((r) => r.data);
  const contacts = [];
  for (const contact of [
    ...new Set(
      [...tasks.map((task) => task.contactId), ...links.map((link) => link.contactId)].filter(
        Boolean,
      ),
    ),
  ])
    contacts.push(await contactProjection(tx, owner, contact));
  const resumeRefs = (
    await tx.query(
      `SELECT id,version,label,stack,language,local_ref AS "localRef" FROM career.resume_refs WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY created_at,id`,
      [owner, application.resumeIds],
    )
  ).rows;
  const superseded = new Set(events.map((event) => event.supersedesEventId).filter(Boolean));
  // Corrections lock exact physical application references, not merged history.
  const affectedBatches = (await tx.query<{ id: string; version: number; status: string }>(
    `SELECT DISTINCT b.id,b.version,b.status FROM career.batch_members m
     JOIN career.batches b ON b.owner_id=m.owner_id AND b.id=m.batch_id
     WHERE m.owner_id=$1 AND m.application_id=$2 ORDER BY b.id`, [owner, application.id],
  )).rows;
  return {
    application,
    affectedBatches,
    links,
    evidence,
    tasks,
    contacts,
    resumeRefs,
    events: events.map((event) => ({ ...event, superseded: superseded.has(event.id) })),
  };
}

export async function readRoute(
  database: ReturnType<typeof createDatabase>,
  actor: AuthenticatedActor,
  url: URL,
  context: RequestContext,
): Promise<{ status: number; body: unknown; contentType?: string }> {
  return database.transaction(
    actor,
    async (tx) => {
      const path = url.pathname.slice('/api/v1/'.length);
      if (path === 'agent-credentials') {
        params(url, ['limit', 'cursor']);
        const page = paging(url, { path });
        const rows = (await tx.query(`SELECT ${credentialProjection},${timestamp('created_at')} AS "cursorTime" FROM career.agent_credentials WHERE owner_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::uuid)) ORDER BY created_at,id LIMIT $4`, [actor.ownerId, page.after?.createdAt ?? null, page.after?.id ?? null, page.limit + 1])).rows;
        const selected = rows.slice(0, page.limit); const last = selected.at(-1);
        return { status: 200, body: { items: selected.map(row => { const safe = { ...row }; delete safe.cursorTime; return credentialMetadata(safe); }), nextCursor: rows.length > page.limit && last ? nextCursor({ id: last.id, createdAt: last.cursorTime }, page.scopeHash) : null } };
      }
      if (path === 'applications')
        return { status: 200, body: await applications(tx, actor.ownerId, url) };
      if (path.startsWith('applications/')) {
        params(url, []);
        return {
          status: 200,
          body: await detail(tx, actor.ownerId, parse(uuidSchema, path.slice(13))),
        };
      }
      if (path.startsWith('contacts/')) {
        params(url, []);
        return { status: 200, body: await contactProjection(tx, actor.ownerId, parse(uuidSchema, path.slice(9))) };
      }
      if (path === 'contacts') {
        params(url, ['limit', 'cursor']);
        const page = paging(url, { path });
        const result = await tx.query<{ total: number; rows: { id: string; createdAt: string }[] }>(
          `WITH filtered AS MATERIALIZED (SELECT id,created_at FROM career.contacts WHERE owner_id=$1),
           page AS (SELECT * FROM filtered WHERE ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::uuid)) ORDER BY created_at,id LIMIT $4)
           SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'createdAt',${timestamp('created_at')}) ORDER BY created_at,id) FROM page),'[]') AS rows`,
          [actor.ownerId, page.after?.createdAt ?? null, page.after?.id ?? null, page.limit + 1],
        );
        const data = result.rows[0]!; const rows = data.rows.slice(0, page.limit);
        const items = [];
        for (const row of rows) items.push(await contactProjection(tx, actor.ownerId, row.id));
        return { status: 200, body: { items, total: data.total, nextCursor: data.rows.length > page.limit ? nextCursor(rows.at(-1), page.scopeHash) : null } };
      }
      if (path === 'health') {
        params(url, []);
        return { status: 200, body: { status: 'ok' } };
      }
      if (path === 'settings') {
        params(url, []);
        return { status: 200, body: await settings(tx, actor.ownerId) };
      }
      if (path === 'analytics') {
        params(url, ['query']);
        const result = await analytics(
          tx,
          actor.ownerId,
          decode(url.searchParams.get('query') ?? '{}'),
        );
        return {
          status: 200,
          body: {
            ...result,
            filters: result.query.filters ?? {},
            population_label: result.populations.selected.label,
            metrics: result.conversions,
          },
        };
      }
      if (path === 'today') {
        params(url, ['date']);
        const date = parse(localDaySchema, url.searchParams.get('date'));
        const projection = await loadReviewProjection(
          tx,
          actor.ownerId,
          '00000000-0000-4000-8000-000000000000',
        );
        const rows = projection.rows.filter(
          (row) =>
            row.submissionStatus === 'confirmado' &&
            row.countingEligible &&
            !row.canonicalApplicationId,
        );
        const ids = rows
          .filter((row) => toLocalDay(row.submittedDate) === date)
          .map((row) => row.id);
        const superseded = new Set(projection.events.map((e) => e.supersedesEventId));
        const canonical = canonicalAttribution(projection.rows);
        const events = projection.events
          .filter((e) => !superseded.has(e.id))
          .map((event) => ({ ...event, canonicalApplicationId: canonical(event.applicationId) }));
        // O conhecimento de um resultado não depende de haver confirmação do envio.
        const historical = new Set(
          projection.rows
            .filter(
              (row) => row.canonicalApplicationId === null && row.cycleRelation === 'before_reset',
            )
            .map((row) => row.id),
        );
        const resultKinds = new Set([
          'retorno_substantivo',
          'avaliacao',
          'entrevista',
          'proposta',
          'contratacao',
          'rejeicao',
          'desistencia',
          'encerramento',
        ]);
        return {
          status: 200,
          body: {
            date,
            asOf: projection.asOf,
            dailyGoal: (await settings(tx, actor.ownerId)).dailyGoal,
            submitted: { count: ids.length, applicationIds: ids },
            tasks: await listTodayTasks(tx, actor.ownerId, date),
            recentEvents: events
              .slice()
              .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id))
              .slice(0, 100),
            historicalResults: events.filter(
              (e) => historical.has(e.canonicalApplicationId) && resultKinds.has(e.kind),
            ),
            unknownDateApplicationIds: rows
              .filter((row) => toLocalDay(row.submittedDate) === null)
              .map((row) => row.id),
          },
        };
      }
      if (path === 'resume-refs') {
        params(url, ['limit', 'cursor', 'search']);
        const search = parse(z.string().max(200), url.searchParams.get('search') ?? '');
        const page = paging(url, { path, search });
        const result = await tx.query<{
          total: number;
          items: { id: string; createdAt: string }[];
        }>(
          `WITH filtered AS MATERIALIZED (SELECT id,version,label,stack,language,local_ref AS "localRef",created_at FROM career.resume_refs WHERE owner_id=$1 AND strpos(lower(concat_ws(' ',label,language,array_to_string(stack,' '))),lower($2))>0), page AS (SELECT * FROM filtered WHERE ($3::timestamptz IS NULL OR (created_at,id)>($3::timestamptz,$4::uuid)) ORDER BY created_at,id LIMIT $5) SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg((to_jsonb(page)-'created_at') || jsonb_build_object('createdAt',${timestamp('created_at')}) ORDER BY created_at,id) FROM page),'[]') AS items`,
          [
            actor.ownerId,
            search,
            page.after?.createdAt ?? null,
            page.after?.id ?? null,
            page.limit + 1,
          ],
        );
        const data = result.rows[0]!;
        const items = data.items.slice(0, page.limit);
        return {
          status: 200,
          body: {
            items,
            total: data.total,
            nextCursor:
              data.items.length > page.limit ? nextCursor(items.at(-1), page.scopeHash) : null,
          },
        };
      }
      if (path === 'batches') {
        params(url, ['limit', 'cursor']);
        const page = paging(url, { path });
        const cycles = (
          await tx.query<{ id: string; is_current: boolean }>(
            'SELECT id,is_current FROM career.cycles WHERE owner_id=$1 ORDER BY id',
            [actor.ownerId],
          )
        ).rows;
        const current = cycles.filter((cycle) => cycle.is_current);
        if (cycles.length && current.length !== 1) throw new SafeError('CYCLE_CONFIGURATION');
        if (!current[0])
          return {
            status: 200,
            body: { state: 'not_started', cycleId: null, items: [], total: 0, nextCursor: null },
          };
        const result = await tx.query<{
          total: number;
          items: { id: string; createdAt: string }[];
        }>(
          `WITH filtered AS MATERIALIZED (
        SELECT t.id,t.created_at,${transferProjection('batches')} AS data FROM career.batches t WHERE t.owner_id=$1 AND t.cycle_id=$2),
        page AS (SELECT * FROM filtered WHERE ($3::timestamptz IS NULL OR (created_at,id)>($3::timestamptz,$4::uuid)) ORDER BY created_at,id LIMIT $5)
        SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(data || jsonb_build_object('createdAt',${timestamp('created_at')}) ORDER BY created_at,id) FROM page),'[]') AS items`,
          [
            actor.ownerId,
            current[0].id,
            page.after?.createdAt ?? null,
            page.after?.id ?? null,
            page.limit + 1,
          ],
        );
        const data = result.rows[0]!;
        const items = data.items.slice(0, page.limit);
        return {
          status: 200,
          body: {
            state: 'started',
            cycleId: current[0].id,
            items,
            total: data.total,
            nextCursor:
              data.items.length > page.limit ? nextCursor(items.at(-1), page.scopeHash) : null,
          },
        };
      }
      if (path.startsWith('batches/')) {
        params(url, []);
        const id = parse(uuidSchema, path.slice(8));
        const row = (
          await tx.query(
            `SELECT ${transferProjection('batches')} AS data FROM career.batches t WHERE owner_id=$1 AND id=$2`,
            [actor.ownerId, id],
          )
        ).rows[0];
        if (!row) throw new SafeError('NOT_FOUND');
        const members = (
          await tx.query(
            `SELECT application_id AS "applicationId",captured_order AS "capturedOrder",eligible,allocation FROM career.batch_members WHERE owner_id=$1 AND batch_id=$2 ORDER BY captured_order,id`,
            [actor.ownerId, id],
          )
        ).rows;
        const versions = (
          await tx.query(
            `SELECT id,version_number AS "versionNumber",type,${timestamp('created_at')} AS "recordedAt" FROM career.review_versions WHERE owner_id=$1 AND batch_id=$2 ORDER BY version_number`,
            [actor.ownerId, id],
          )
        ).rows;
        const live = await loadReviewProjection(tx, actor.ownerId, id);
        const preview = buildReviewSnapshot(live.rows, live.events, live.populationIds, live.asOf, live.countedPopulationIds);
        const frozen = row.data.status === 'closed' ? (await tx.query<{ population_ids: string[] }>('SELECT population_ids FROM career.review_versions WHERE owner_id=$1 AND batch_id=$2 ORDER BY version_number DESC LIMIT 1', [actor.ownerId, id])).rows[0]?.population_ids : null;
        const rectificationPreview = row.data.status === 'closed'
          ? buildReviewSnapshot(live.rows, live.events, frozen ?? live.populationIds, live.asOf, frozen ?? live.populationIds) : null;
        return { status: 200, body: { batch: row.data, members, versions, preview, rectificationPreview } };
      }
      if (path.startsWith('reviews/')) {
        params(url, ['format']);
        const format = url.searchParams.has('format') ? parse(z.literal('markdown'), url.searchParams.get('format')) : null;
        const id = parse(uuidSchema, path.slice(8));
        const version = (
          await tx.query(
            `SELECT ${transferProjection('review_versions')} AS data FROM career.review_versions t WHERE owner_id=$1 AND id=$2`,
            [actor.ownerId, id],
          )
        ).rows[0]?.data;
        if (!version) throw new SafeError('NOT_FOUND');
        if (format === 'markdown') return { status: 200, body: reviewMarkdown(version), contentType: 'text/markdown; charset=utf-8' };
        const live = await loadReviewProjection(tx, actor.ownerId, version.batchId);
        const captured = new Set(version.eventIds);
        const canonical = canonicalAttribution(live.rows);
        // Comparação viva em ambas as direções; os IDs congelados não são alterados.
        const population = new Set((version.populationIds as string[]).map(canonical));
        const superseded = new Set(live.events.map((event) => event.supersedesEventId));
        return {
          status: 200,
          body: {
            version,
            externalResults: live.events.filter((event) => (version.snapshot.externalResultEventIds ?? []).includes(event.id)),
            laterResults: live.events
              .map((event) => ({
                ...event,
                canonicalApplicationId: canonical(event.applicationId),
              }))
              .filter(
                (event) =>
                  population.has(event.canonicalApplicationId) &&
                  !captured.has(event.id) &&
                  !superseded.has(event.id),
              ),
          },
        };
      }
      if (path === 'exports') {
        params(url, ['format']);
        const format = parse(z.enum(['json', 'csv']), url.searchParams.get('format'));
        const snapshot = await readSnapshot(tx, actor.ownerId);
        return format === 'json'
          ? { status: 200, body: snapshot }
          : { status: 200, body: snapshotCsv(snapshot), contentType: 'text/csv; charset=utf-8' };
      }
      throw new SafeError('NOT_FOUND');
    },
    context,
    readPermission(url),
  );
}
