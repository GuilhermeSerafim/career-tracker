import {
  createServer,
  request as nodeRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
} from 'node:http';
import { once } from 'node:events';
import { createApp, type ApiDependencies } from '../../server/app';

export function startApi(
  dependencies: ApiDependencies,
  prepare?: (request: IncomingMessage) => void,
) {
  const app = createApp(dependencies);
  return startHandler((request, response) => {
    prepare?.(request);
    void app(request, response);
  });
}
export async function startHandler(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Servidor local indisponível.');
  return {
    port: address.port,
    async request(
      path: string,
      options: {
        method?: string;
        headers?: IncomingHttpHeaders;
        body?: string;
        chunks?: string[];
      } = {},
    ) {
      // O teste inspeciona contratos diferentes por rota e valida a forma recebida.
      return new Promise<{
        status: number;
        headers: IncomingHttpHeaders;
        text: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        json: Record<string, any>;
      }>((resolve, reject) => {
        const req = nodeRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            path,
            method: options.method ?? 'GET',
            headers: options.headers,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let json = {};
              try {
                json = JSON.parse(text);
              } catch {
                /* CSV e HTML de smoke. */
              }
              resolve({ status: res.statusCode!, headers: res.headers, text, json });
            });
          },
        );
        req.on('error', reject);
        for (const chunk of options.chunks ?? (options.body ? [options.body] : []))
          req.write(chunk);
        req.end();
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
