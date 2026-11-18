import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as auth from '../../server/auth';
import { commandPermission, readPermission } from '../../server/agent-policy';
vi.mock('node:crypto', async importOriginal => { const actual = await importOriginal<typeof import('node:crypto')>(); return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }; });

describe('opaque agent boundary', () => {
  it('verifies opaque secret, brands identity and rejects a copied identity', async () => {
    const id = randomUUID(); const secret = randomBytes(32).toString('base64url');
    const lookup = vi.fn(async () => ({ id, hash: createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex'), scopes: ['career:read'], expires_at: null, revoked_at: null }));
    const actor = await auth.authenticateAgent(`Bearer ct_agent_${id}.${secret}`, { ownerUserId: id }, { lookupAgentCredential: lookup });
    expect(actor).toMatchObject({ actorKind: 'agent', actorId: id, ownerId: id, source: 'agent' });
    expect(() => auth.assertAuthenticatedActor(actor, id)).not.toThrow();
    expect(() => auth.assertAuthenticatedActor({ ...actor }, id)).toThrow();
    expect(() => auth.assertAuthenticatedOwner(actor as never, id)).toThrow();
    expect(lookup).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('uses one generic unauthorized outcome including absent credentials', async () => {
    vi.mocked(timingSafeEqual).mockClear();
    const id = randomUUID(); const secret = randomBytes(32).toString('base64url');
    for (const row of [null, { id, hash: '0'.repeat(64), scopes: ['career:read'], expires_at: null, revoked_at: null }]) {
      await expect(auth.authenticateAgent(`Bearer ct_agent_${id}.${secret}`, { ownerUserId: id }, { lookupAgentCredential: async () => row })).rejects.toMatchObject({ status: 401 });
    }
    expect(vi.mocked(timingSafeEqual).mock.calls.map(args => args.map(value => value.byteLength))).toEqual([[32,32],[32,32]]);
  });
  it('maps exact operations and export formats, defaulting to owner only', () => {
    expect(commandPermission('create_resume_ref')).toBe('career:write');
    expect(commandPermission('start_cycle')).toBe('owner');
    expect(commandPermission('create_agent_credential')).toBe('owner');
    expect(commandPermission('close_review')).toBe('career:reviews');
    for (const path of ['/contacts', '/contacts/00000000-0000-4000-8000-000000000001', '/reviews/00000000-0000-4000-8000-000000000001']) expect(readPermission(new URL('https://example.test/api/v1' + path))).toBe('career:read');
    expect(readPermission(new URL('https://example.test/api/v1/reviews/00000000-0000-4000-8000-000000000001?format=markdown'))).toBe('career:export');
    expect(readPermission(new URL('https://example.test/api/v1/settings'))).toBe('career:read');
  });
});
