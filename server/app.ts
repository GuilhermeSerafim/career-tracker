import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createDatabase } from './database';
import type { AuthenticatedActor } from './auth';
import { createRequestContext } from './database.js';
import { SafeError, errorResponse } from './errors.js';
import { MAX_COMMAND_BYTES } from '../shared/commands.js';
import { createSafeLogger, type RequestLog } from './logger.js';
import { createWriteRoute } from './routes/write.js';
import { readRoute } from './routes/read.js';
import { fixturePath, removeFixture } from './routes/maintenance.js';
import { createTransferRoute } from './routes/transfer.js';
import { assertRepresentableJson } from './input.js';

// Margem explícita abaixo dos 4,5 MB de request/response da Vercel.
export const MAX_HTTP_TRANSFER_BYTES = 4_000_000;
export const MAX_HTTP_RESPONSE_BYTES = 4_000_000;

export interface ApiDependencies {
  database: ReturnType<typeof createDatabase>;
  authenticate(header: string | undefined): Promise<AuthenticatedActor>;
  rateLimit?: { requests: number; windowMs: number };
  logger?: (entry: RequestLog) => void;
}

/** headers pode descartar duplicatas. Conferir a cardinalidade observável antes
 * de escolher credencial ou interpretar o corpo, inclusive valores idênticos. */
function assertSingletonHeaders(request: IncomingMessage): void {
  const singleton = ['authorization', 'content-type'];
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (singleton.includes(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of singleton) {
    if ((counts.get(name) ?? 0) > 1 || (request.headersDistinct?.[name]?.length ?? 0) > 1)
      throw new SafeError('INVALID_INPUT');
  }
}

export async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    request.resume();
    throw new SafeError('PAYLOAD_TOO_LARGE');
  }
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
    request.headers['content-encoding']
  )
    throw new SafeError('INVALID_INPUT');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        if (!failed) {
          failed = true;
          chunks.length = 0;
          reject(new SafeError('PAYLOAD_TOO_LARGE'));
        }
        return;
      }
      if (!failed) chunks.push(chunk);
    });
    request.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    request.on('error', () => reject(new SafeError('INVALID_INPUT')));
    request.on('aborted', () => reject(new SafeError('INVALID_INPUT')));
  });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SafeError('INVALID_INPUT');
  }
  assertRepresentableJson(body);
  return body;
}

const reads =
  /^\/api\/v1\/(?:applications(?:\/[^/]+)?|contacts(?:\/[^/]+)?|today|analytics|batches(?:\/[^/]+)?|reviews\/[^/]+|settings|agent-credentials|resume-refs|exports|health)$/;
const writes = /^\/api\/v1\/(?:commands|imports\/(?:preview|apply)|restores\/preview)$/;
/** Adaptador Node compartilhado pelo desenvolvimento e pela função hospedada. */
export function createApp(dependencies: ApiDependencies) {
  const write = createWriteRoute(dependencies.database);
  const transfer = createTransferRoute(dependencies.database);
  const log = dependencies.logger ?? createSafeLogger();
  const rate = dependencies.rateLimit ?? { requests: 240, windowMs: 60_000 };
  // Um único proprietário configurado: memória limitada e nenhum IP/URL no contador.
  let bucket = { start: 0, count: 0 };
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const context = createRequestContext();
    const start = performance.now();
    let status = 503;
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Authorization',
      'X-Request-Id': context.requestId,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    };
    try {
      assertSingletonHeaders(request);
      if ((request.url?.length ?? 0) > 14_000 || !request.url?.startsWith('/'))
        throw new SafeError('INVALID_INPUT');
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === fixturePath && /^Bearer ct_agent_/i.test(request.headers.authorization ?? ''))
        throw new SafeError('FORBIDDEN');
      const actor = await dependencies.authenticate(request.headers.authorization);
      if (Date.now() - bucket.start >= rate.windowMs) bucket = { start: Date.now(), count: 0 };
      if (++bucket.count > rate.requests) {
        response.setHeader(
          'Retry-After',
          Math.max(1, Math.ceil((rate.windowMs - (Date.now() - bucket.start)) / 1000)),
        );
        throw new SafeError('QUOTA_EXCEEDED');
      }
      const expected = reads.test(url.pathname) ? 'GET' : writes.test(url.pathname) || url.pathname === fixturePath ? 'POST' : null;
      if (!expected) throw new SafeError('NOT_FOUND');
      if (request.method !== expected) {
        response.setHeader('Allow', expected);
        throw new SafeError('METHOD_NOT_ALLOWED');
      }
      let result: { status: number; body: unknown; contentType?: string };
      if (expected === 'GET') result = await readRoute(dependencies.database, actor, url, context);
      else {
        if (url.search) throw new SafeError('INVALID_INPUT');
        const body = await readJson(
          request,
          url.pathname === fixturePath ? 1024 : url.pathname.endsWith('/commands') ? MAX_COMMAND_BYTES : MAX_HTTP_TRANSFER_BYTES,
        );
        const key = request.headers['idempotency-key'];
        if (Array.isArray(key)) throw new SafeError('INVALID_INPUT');
        if (url.pathname === fixturePath) result = await removeFixture(dependencies.database, actor, body, key, context);
        else if (url.pathname.endsWith('/commands')) result = await write(actor, body, key, context);
        else {
          if (actor.actorKind !== 'owner') throw new SafeError('FORBIDDEN');
          result = await transfer(actor, url.pathname, body, key, context);
        }
      }
      const serialized = result.contentType ? String(result.body) : JSON.stringify(result.body);
      if (Buffer.byteLength(serialized) > MAX_HTTP_RESPONSE_BYTES)
        throw new SafeError(
          url.pathname === '/api/v1/exports' ? 'EXPORT_TOO_LARGE' : 'PAYLOAD_TOO_LARGE',
        );
      status = result.status;
      response.writeHead(status, {
        ...headers,
        ...(result.contentType ? { 'Content-Type': result.contentType } : {}),
      });
      response.end(serialized);
    } catch (error) {
      const result = errorResponse(error, context.requestId);
      status = result.status;
      // Mantém o requestId da fronteira, inclusive se um serviço gerou outro erro seguro.
      result.body.error.requestId = context.requestId;
      response.writeHead(status, headers);
      response.end(JSON.stringify(result.body));
      request.resume();
    } finally {
      try {
        log({
          requestId: context.requestId,
          operation: 'http_request',
          status,
          elapsedMs: performance.now() - start,
        });
      } catch {
        /* Sink isolado. */
      }
    }
  };
}
