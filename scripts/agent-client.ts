import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { commandSchema, MAX_COMMAND_BYTES } from '../shared/commands';
import { commandPermission, readPermission } from '../server/agent-policy';
import { validateSnapshot } from '../domain/export';

const inputSchema = z.union([
  z.strictObject({ method: z.literal('GET'), path: z.string().max(14_000) }),
  z.strictObject({ command: commandSchema, idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/) }),
]);
const safeFailure = (status: number) => JSON.stringify({ status, error: status === 503 ? 'Serviço indisponível; repita a mesma intenção e chave.' : status === 409 ? 'Conflito; releia o registro e envie uma correção explícita com nova chave.' : status === 401 ? 'Credencial inválida, expirada ou revogada.' : status === 403 ? 'Operação não autorizada.' : 'Solicitação recusada.' });
/** Bytes, not a locale-decoded native-process string. No implicit retry/new key. */
export async function runAgentCommand(bytes: Uint8Array, env: NodeJS.ProcessEnv, transport: typeof fetch = fetch): Promise<string> {
  let origin: URL;
  try { origin = new URL(env.CAREER_API_URL!); } catch { throw Error('Configuração inválida.'); }
  const token = env.CAREER_AGENT_TOKEN;
  if (!token || token.length > 512 || /\s/.test(token) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname))) throw Error('Configuração inválida.');
  let input: z.infer<typeof inputSchema>;
  try {
    if (bytes.byteLength > MAX_COMMAND_BYTES) throw Error();
    input = inputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { throw Error('Entrada inválida.'); }
  let path = '/api/v1/commands'; let body: string | undefined; let key: string | undefined;
  if ('command' in input) {
    if (commandPermission(input.command.operation) === 'owner') throw Error('Entrada inválida.');
    body = JSON.stringify(input.command); key = input.idempotencyKey;
  } else {
    path = input.path;
    if (!/^\/api\/v1\/[a-z0-9/-]+(?:\?[^#\\]*)?$/.test(path) || path.includes('..') || path.includes('//') || readPermission(new URL(path, origin)) === 'owner') throw Error('Entrada inválida.');
  }
  try {
    const response = await transport(new URL(path, origin), { method: body ? 'POST' : 'GET', body, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key! } : {}) } });
    if (!response.ok) return safeFailure([401,403,409,503].includes(response.status) ? response.status : 400);
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4_000_000) throw Error(); chunks.push(value); } } finally { await reader.cancel(); }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const data: unknown = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : { text };
    const target = new URL(path, origin);
    if (target.pathname === '/api/v1/exports' && target.searchParams.get('format') === 'json') validateSnapshot(data);
    const secret = token.startsWith('ct_agent_') ? token.split('.').at(-1)! : '';
    const secretHash = secret ? createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex') : '';
    // JSON escaping preserves newlines/CSV/evidence and prevents terminal execution.
    // Escape the remaining bidi/C1 controls which JSON.stringify leaves literal.
    const serialized = JSON.stringify(data);
    // Reject contaminated output rather than corrupting a complete export's hashes/history.
    // Credential storage is excluded by server projections, not historical-key blacklists.
    if ([token, secret, secretHash].some(value => value && serialized.includes(value))) throw Error('Resposta inválida.');
    return serialized.replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  } catch { return safeFailure(503); }
}
async function main() {
  try {
    if (process.argv.length !== 2) throw Error('Entrada inválida.');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > MAX_COMMAND_BYTES) throw Error('Entrada inválida.'); chunks.push(bytes); }
    process.stdout.write(await runAgentCommand(Buffer.concat(chunks), process.env) + '\n');
  } catch { process.stderr.write('Não foi possível executar. Confira o ambiente privado e o JSON UTF-8.\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
