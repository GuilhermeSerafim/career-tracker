import { it, expect } from 'vitest';
import { runAgentCommand } from '../../scripts/agent-client';
import { buildSnapshot, validateSnapshot } from '../../domain/export';
it('decodes UTF8 evidence bytes unchanged, preserves key/version and sanitizes output', async () => {
  const text = 'Ação: não enviei mensagem; revisão amanhã.';
  const payload = { command: { operation: 'update_application', application: { id: '00000000-0000-4000-8000-000000000001', expectedVersion: 2 }, changes: { notes: text } }, idempotencyKey: 'unchanged-intention' };
  const token = 'synthetic-private-token'; let captured: RequestInit | undefined;
  const transport: typeof fetch = async (_input, init) => { captured = init; return Response.json({ notes: text, escape: '\u001b[31m' }); };
  const output = await runAgentCommand(Buffer.from(JSON.stringify(payload), 'utf8'), { CAREER_AGENT_TOKEN: token, CAREER_API_URL: 'https://example.test' }, transport);
  expect(JSON.parse(String(captured?.body)).changes.notes).toBe(text);
  expect(JSON.parse(String(captured?.body)).application.expectedVersion).toBe(2);
  expect(new Headers(captured?.headers).get('Idempotency-Key')).toBe(payload.idempotencyKey);
  expect(output.includes(text)).toBe(true); expect(output.includes(token)).toBe(false); expect(output.includes('\u001b')).toBe(false);
  const refused = await runAgentCommand(Buffer.from(JSON.stringify(payload)), { CAREER_AGENT_TOKEN: token, CAREER_API_URL: 'https://example.test' }, async () => Response.json({ arbitraryField: token }));
  expect(refused.includes(token)).toBe(false); expect(JSON.parse(refused).status).toBe(503);
});
it('preserves opaque historical source keys and complete snapshot integrity', async () => {
  const date = '2026-11-17T12:00:00Z'; const owner = '00000000-0000-4000-8000-000000000001';
  const snapshot = buildSnapshot(owner, [{ formatVersion: 1, table: 'import_runs', data: { id: '00000000-0000-4000-8000-000000000002', version: 1, createdAt: date, updatedAt: date, importerVersion: 'fictitious/1', sourceSetHash: 'a'.repeat(64), status: 'pending', pendingIssues: [], unitState: { token: 'fictional job field', secret: 'literal legacy source key', nested: { password: 'historical label', tokenHash: 'historical opaque value' } } } }], date);
  const output = await runAgentCommand(Buffer.from(JSON.stringify({ method: 'GET', path: '/api/v1/exports?format=json' })), { CAREER_AGENT_TOKEN: 'synthetic-private-token', CAREER_API_URL: 'https://example.test' }, async () => Response.json(snapshot));
  expect(validateSnapshot(JSON.parse(output))).toEqual(snapshot);
});
it('returns bounded generic failures, rejects credential URLs, invalid UTF8 and secret/admin commands', async () => {
  const env = { CAREER_AGENT_TOKEN: 'private', CAREER_API_URL: 'https://example.test' };
  const body = Buffer.from(JSON.stringify({ method: 'GET', path: '/api/v1/contacts' }));
  expect(await runAgentCommand(body, env, async () => { throw Error('private SQL'); })).toBe('{"status":503,"error":"Serviço indisponível; repita a mesma intenção e chave."}');
  for (const bytes of [Buffer.from([0xff]), Buffer.from(JSON.stringify({ command: { operation: 'create_agent_credential' }, idempotencyKey: 'x' }))]) await expect(runAgentCommand(bytes, env)).rejects.toThrow('Entrada inválida.');
  await expect(runAgentCommand(body, { ...env, CAREER_API_URL: 'https://user:password@example.test' })).rejects.toThrow('Configuração inválida.');
});
it('preserves business stacks, source/manifest hashes and multiline text through escaped JSON output', async () => {
  const env = { CAREER_AGENT_TOKEN: 'synthetic-private-token', CAREER_API_URL: 'https://example.test' };
  const input = Buffer.from(JSON.stringify({ method: 'GET', path: '/api/v1/analytics' }));
  const data = { stack: ['TypeScript','SQL'], groups: { stack: { TypeScript: 2 } }, manifestHash: 'a'.repeat(64), sources: [{ hash: 'b'.repeat(64), sourceHash: 'c'.repeat(64) }], evidence: 'Ação relatada.\nNão enviei mensagem.\tLiteral\u001b[31m', direction: '\u202eLiteral' };
  const output = await runAgentCommand(input, env, async () => Response.json(data));
  expect(JSON.parse(output)).toEqual(data);
  expect(output.includes('\u001b')).toBe(false); expect(output.includes('\u202e')).toBe(false);
  const csv = 'empresa,observação\r\n"Fictícia","Ação\nrelatada"\r\n';
  const csvOutput = await runAgentCommand(Buffer.from(JSON.stringify({ method: 'GET', path: '/api/v1/exports?format=csv' })), env, async () => new Response(csv, { headers: { 'content-type': 'text/csv' } }));
  expect(JSON.parse(csvOutput).text).toBe(csv);
});
