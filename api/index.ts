import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRuntimeApp } from '../server/runtime.js';

// O adaptador lê o stream bruto; nunca acessa request.body/helper antes do limite.
let runtime: ReturnType<typeof createRuntimeApp> | undefined;
export default function handler(request: IncomingMessage, response: ServerResponse) {
  runtime ??= createRuntimeApp();
  return runtime.handler(request,response);
}
