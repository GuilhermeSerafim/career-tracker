import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestContext } from './database.js';
import { errorResponse, SafeError } from './errors.js';

export function unavailable(_request: IncomingMessage, response: ServerResponse): void {
  const request = createRequestContext();
  const result = errorResponse(new SafeError('NOT_CONFIGURED'),request.requestId);
  response.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    Vary: 'Authorization',
    'X-Request-Id': request.requestId,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(result.body));
  _request.resume();
}
