import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { syntheticCareerApi } from '../helpers/synthetic-career';

it('pages independent contacts privately without mutations and rejects invalid or foreign-scope reads', async () => {
  const api = await syntheticCareerApi(); let foreign = '';
  const read = (query = '') => api.request(`/api/v1/contacts${query}`, { headers: api.headers });
  try {
    const empty = await read(); expect(empty.status).toBe(200); expect(empty.json).toEqual({ items: [], total: 0, nextCursor: null });
    expect(empty.headers['cache-control']).toBe('private, no-store'); expect(empty.headers.vary).toBe('Authorization');
    const ids: string[] = [];
    for (const name of [null, 'Contato fictício B', 'Contato fictício C']) {
      const saved = await api.post({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name, notes: 'Informação fictícia', links: [{ originalUrl: 'https://example.test/conversation?token=fictional', comparisonUrl: null, kind: 'contato', isLocal: false, isPrivate: true }] } });
      expect(saved.status).toBe(201); ids.push(saved.json.contact.id);
    }
    foreign = await api.foreignContact(); const audit = await api.auditCount();
    const first = await read('?limit=2'); expect(first.status).toBe(200); expect(first.json.total).toBe(3); expect(first.json.items.map((c: { id: string }) => c.id)).toEqual(ids.slice(0, 2));
    expect(first.json.items[0]).toMatchObject({ version: 1, name: null, notes: 'Informação fictícia', links: [{ originalUrl: 'https://example.test/conversation?token=fictional' }] });
    const second = await read(`?limit=2&cursor=${first.json.nextCursor}`); expect(second.status).toBe(200); expect(second.json.items.map((c: { id: string }) => c.id)).toEqual([ids[2]]); expect(second.json.nextCursor).toBeNull(); expect(second.json.total).toBe(3);
    expect((await read('?limit=1')).json.items[0].version).toBe(1); expect(await api.auditCount()).toBe(audit);
    const applications = await api.request('/api/v1/applications?view=all&limit=100', { headers: api.headers }); expect(applications.json.total).toBe(0);
    const cursor = JSON.parse(Buffer.from(first.json.nextCursor, 'base64url').toString('utf8')); cursor.scope = '0'.repeat(64);
    for (const query of ['?search=x', '?limit=0', '?limit=101', '?limit=1&limit=2', '?cursor=bad!', `?cursor=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`]) expect((await read(query)).status).toBe(400);
    expect((await api.request('/api/v1/contacts', { headers: { authorization: 'Bearer other.payload.signature' } })).status).toBe(403);
    expect((await api.request(`/api/v1/contacts/${foreign}`, { headers: api.headers })).status).toBe(404);
    await api.maintenance(true); try { expect((await read()).status).toBe(503); } finally { await api.maintenance(false); }
    expect(await api.auditCount()).toBe(audit);
  } finally { if (foreign) await api.removeForeignContact(foreign); await api.close(); }
});
