import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syntheticCareerApi } from '../helpers/synthetic-career';

let fixture: Awaited<ReturnType<typeof syntheticCareerApi>>;
beforeAll(async () => { fixture = await syntheticCareerApi(); });
afterAll(async () => { await fixture?.close(); });
describe('authenticated single-contact HTTP read with restricted PostgreSQL', () => {
  it('reads exactly the owner contact and safe metadata without changing audit/version', async () => {
    const saved = await fixture.post({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: '<Contato fictício>', notes: 'Informado pelo usuário.', links: [{ originalUrl: 'https://example.test/conversa?token=synthetic', comparisonUrl: null, kind: 'conversa', isLocal: false, isPrivate: true }] } });
    expect(saved.status).toBe(201);
    const before = await fixture.auditCount();
    const path = `/api/v1/contacts/${saved.json.contact.id}`;
    for (let index = 0; index < 2; index++) {
      const response = await fixture.request(path, { headers: fixture.headers });
      expect(response.status).toBe(200); expect(response.json).toEqual(saved.json.contact);
      expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.headers.vary).toBe('Authorization');
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await fixture.auditCount()).toBe(before);
  });
  it('preserves strict input, auth, owner isolation, method and maintenance errors', async () => {
    const foreignId = await fixture.foreignContact();
    const path = `/api/v1/contacts/${foreignId}`;
    try {
      for (const [target, options, status] of [
        [path, {}, 401],
        [path, { headers: { authorization: 'Bearer other.payload.signature' } }, 403],
        [path, { headers: fixture.headers }, 404],
        [`/api/v1/contacts/${randomUUID()}`, { headers: fixture.headers }, 404],
        ['/api/v1/contacts/not-a-uuid', { headers: fixture.headers }, 400],
        [path + '?ownerId=' + fixture.owner, { headers: fixture.headers }, 400],
        [path, { headers: fixture.headers, method: 'POST' }, 405],
        ['/api/v1/contacts', {}, 401],
        ['/api/v1/contacts?limit=1&limit=2', { headers: fixture.headers }, 400],
      ] as const) {
        const response = await fixture.request(target, options);
        expect(response.status).toBe(status);
        expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.headers.vary).toBe('Authorization');
        expect(response.json.error.requestId).toBe(response.headers['x-request-id']);
        expect(Object.keys(response.json.error).sort()).toEqual(['code', 'message', 'requestId']);
      }
      await fixture.maintenance(true);
      expect((await fixture.request(path, { headers: fixture.headers })).status).toBe(503);
      await fixture.maintenance(false);
      fixture.unavailable(true);
      expect((await fixture.request(path, { headers: fixture.headers })).status).toBe(503);
      fixture.unavailable(false);
    } finally { fixture.unavailable(false); await fixture.maintenance(false); await fixture.removeForeignContact(foreignId); }
  });
});
