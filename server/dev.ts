import { createServer } from 'node:http';
import { createRuntimeApp } from './runtime';

const runtime = createRuntimeApp();
const server = createServer(runtime.handler);
server.listen(3001, '127.0.0.1', () => {
  console.log('API local: http://127.0.0.1:3001');
});
server.on('error', () => {
  console.error('Não foi possível iniciar a API local em 127.0.0.1:3001.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(() => { void runtime.close(); }); });
}
