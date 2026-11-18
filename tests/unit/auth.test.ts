import { describe, expect, it, vi } from 'vitest';
import { authenticateBearer } from '../../server/auth';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const token = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.signature';
const config = { ownerUserId: owner };
describe('fronteira de autenticação humana', () => {
  it('valida a sessão no Auth e usa somente o ID retornado', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: owner } }, error: null });
    const actor = await authenticateBearer(`Bearer ${token}`, config, { getUser });
    expect(getUser).toHaveBeenCalledExactlyOnceWith(token);
    expect(actor).toMatchObject({ ownerId: owner, actorId: owner, actorKind: 'owner', source: 'web' });
    expect(Object.isFrozen(actor)).toBe(true);
  });
  it('não autoriza metadata, email ou ID declarado no JWT', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: other, email: 'owner@example.test', user_metadata: { owner_id: owner } } }, error: null });
    await expect(authenticateBearer(`Bearer ${token}`, config, { getUser })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer a b', 'Bearer ct_agent_secret', 'Bearer career_agent_secret', 'Bearer opaque', `Bearer ${token}\n`])('recusa entrada inválida/agente antes do Auth: %s', async (header) => {
    const getUser = vi.fn();
    await expect(authenticateBearer(header, config, { getUser })).rejects.toMatchObject({ status: 401 });
    expect(getUser).not.toHaveBeenCalled();
  });
  it.each([
    { data: { user: null }, error: null },
    { data: { user: { id: owner } }, error: { message: 'secret-token' } },
  ])('recusa respostas inválidas sem expor detalhes', async (response) => {
    const promise = authenticateBearer(`Bearer ${token}`, config, { getUser: async () => response });
    await expect(promise).rejects.toMatchObject({ status: 401 });
    await expect(promise).rejects.not.toThrow('secret-token');
  });
  it('falha fechada quando Auth está indisponível', async () => {
    await expect(authenticateBearer(`Bearer ${token}`, config, { getUser: async () => { throw new Error(token); } })).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
  });
  it.each([{ status: 503 }, { status: 0 }, { name: 'AuthRetryableFetchError' }])('não confunde indisponibilidade do Auth com sessão expirada', async (error) => {
    await expect(authenticateBearer(`Bearer ${token}`, config, { getUser: async () => ({ data: { user: null }, error }) })).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
  });
});
