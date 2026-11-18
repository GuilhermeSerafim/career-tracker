import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { authenticateBearer } from '../../server/auth';
import { readServerConfig } from '../../server/config';
import { createDatabase } from '../../server/database';
import { SafeError } from '../../server/errors';

// Processo isolado: uma regressão de EventEmitter não pode derrubar o runner inteiro.
const config = readServerConfig();
config.database.idle_in_transaction_session_timeout = 100;
const database = createDatabase(config);
const actor = await authenticateBearer('Bearer eyJhIjox.eyJiIjoy.signature', config, {
  getUser: async () => ({ data: { user: { id: config.ownerUserId } }, error: null }),
});
const warnings: string[] = [];
process.on('warning', (warning) => { warnings.push(warning.name); });
let resume!: () => void;
const pause = new Promise<void>((resolve) => { resume = resolve; });
let finished!: () => void;
const callbackFinished = new Promise<void>((resolve) => { finished = resolve; });
let firstPid: number | undefined;
let lateError: unknown;
const contactId = randomUUID();
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  const operation = database.transaction(actor, async (tx) => {
    firstPid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await tx.query('INSERT INTO career.contacts(id,owner_id,name) VALUES($1,$2,$3)', [contactId, actor.ownerId, 'Teste de rollback por desconexão']);
    await pause;
    try { await tx.query('SELECT 765 AS late_query'); }
    catch (error) { lateError = error; }
    finally { finished(); }
  });
  const observed = await Promise.race([
    operation.then(() => ({ error: undefined }), (error: unknown) => ({ error })),
    new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('A transação não rejeitou enquanto o callback estava pausado.')), 3000); }),
  ]);
  clearTimeout(deadline);
  assert.ok(observed.error instanceof SafeError);
  assert.equal(observed.error.code, 'DATABASE_UNAVAILABLE');
  assert.equal(observed.error.status, 503);
  resume();
  await callbackFinished;
  assert.ok(lateError instanceof SafeError);
  assert.equal(lateError.code, 'DATABASE_UNAVAILABLE');
  const recovered = await database.transaction(actor, async (tx) => {
    const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    const count = (await tx.query<{ count: number }>('SELECT count(*)::integer AS count FROM career.contacts WHERE id=$1', [contactId])).rows[0]?.count;
    return { pid, count };
  });
  assert.ok(firstPid && recovered.pid && recovered.pid !== firstPid);
  assert.equal(recovered.count, 0);
  for (let i = 0; i < 20; i++) await database.assertReady();
  await setImmediate();
  assert.deepEqual(warnings, []);
  console.log(JSON.stringify({ status: 503, rejectedBeforeResume: true, lateQueryBlocked: true, connectionReplaced: true, rolledBack: true, listenerWarnings: warnings.length }));
} finally {
  clearTimeout(deadline);
  resume();
  await database.close();
}
