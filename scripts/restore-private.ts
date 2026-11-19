import { randomUUID } from 'node:crypto';
import pg from 'pg';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertAuthenticatedOwner, createHumanAuthenticator, type AuthenticatedOwner } from '../server/auth';
import { readServerConfig } from '../server/config';
import { readPrivateSnapshot } from './private-transfer-io';
import { MAINTENANCE_LOCK, type Transaction } from '../server/database';
import { insertTransferRow, readDisplayHighWater, readTransferContinuity, readTransferRows } from '../server/repositories/transfers';
import { preflightTransfer } from '../server/repositories/transfer-preflight';
import { hasDisplayCapacity, restorationOrder, restoreDisplayFloor, transferHash, TRANSFER_TABLES, TransferError, validateSnapshot, type Snapshot } from '../domain/export';
import { uuidSchema } from '../shared/model';
export interface RestoreOptions {
    database: pg.ClientConfig;
    ownerId: string;
    actor: AuthenticatedOwner;
    snapshot: Snapshot;
    mode: 'preview' | 'apply' | 'resume';
    runId?: string;
    reassignOwner?: string;
    chunkSize?: number;
    afterChunk?: (committed: number) => Promise<void>;
}
export class RestoreContinuityRequiredError extends TransferError {
    constructor() {
        super();
        this.message = 'A exportação antiga não inclui a continuidade da origem. Confira uma nova captura antes de ativar o destino.';
    }
}
class RestoreSequenceExhaustedError extends TransferError {
    constructor() {
        super();
        this.message = 'A sequência de candidaturas está esgotada. O destino precisa de capacidade para emitir o próximo identificador.';
    }
}
export class RestoreInterruptedError extends TransferError {
    constructor(readonly runId: string) { super(); }
}
export class RestoreStartUncertainError extends TransferError {
    readonly outcome = 'unknown';
    constructor(readonly runId: string) { super(); }
}
interface Run {
    id: string;
    state: string;
    manifest_hash: string;
    destination_key: string;
    expected_rows: string;
    restored_rows: string;
}
/** A credencial de manutenção só é consumida neste módulo local, fora do runtime/API. */
export async function restorePrivate(options: RestoreOptions): Promise<{
    runId: string | null;
    state: string;
}> {
    assertAuthenticatedOwner(options.actor, options.ownerId);
    const snapshot = validateSnapshot(options.snapshot);
    const owner = uuidSchema.parse(options.ownerId);
    if (options.reassignOwner === undefined ? snapshot.manifest.sourceOwnerId !== owner : uuidSchema.parse(options.reassignOwner) !== owner)
        throw new TransferError();
    const continuity = snapshot.manifest.continuity;
    if (!continuity && options.mode !== 'preview') throw new RestoreContinuityRequiredError();
    const chunkSize = options.chunkSize ?? 100;
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1000 || !['preview', 'apply', 'resume'].includes(options.mode))
        throw new TransferError();
    if (options.mode === 'resume' && !uuidSchema.safeParse(options.runId).success || options.mode !== 'resume' && options.runId !== undefined)
        throw new TransferError();
    if (!/^career_restore(?:\.[a-z0-9-]+)?$/.test(options.database.user ?? '') || options.database.connectionString)
        throw new TransferError();
    const manifestHash = transferHash(snapshot);
    const expected = new Map(snapshot.entities.map((row) => [row.table + '/' + row.data.id, transferHash(row)]));
    const rows = restorationOrder(snapshot.entities);
    const client = new pg.Client(options.database);
    client.on('error', () => undefined);
    let runId = options.runId ?? randomUUID();
    let destinationKey = '';
    let transactionActive = false;
    let persisted = false;
    let newStart = false;
    let startCommitAttempted = false;
    const transact = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
        await client.query('BEGIN');
        transactionActive = true;
        try {
            await client.query('SELECT pg_advisory_xact_lock($1,$2)', [...MAINTENANCE_LOCK]);
            await client.query("SET LOCAL TIME ZONE 'UTC'");
            const result = await work(client);
            if (newStart) startCommitAttempted = true;
            await client.query('COMMIT');
            newStart = false;
            transactionActive = false;
            return result;
        }
        catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            transactionActive = false;
            throw error;
        }
    };
    const controls = async (inspectForeign = true) => {
        const identity = (await client.query("SELECT session_user,current_user,current_database() AS database,oid::text FROM pg_database WHERE datname=current_database()")).rows[0];
        if (identity?.session_user !== 'career_restore' || identity.current_user !== 'career_restore')
            throw new TransferError();
        const config = (await client.query('SELECT owner_id FROM career.owner_config WHERE singleton')).rows;
        if (config.length !== 1 || config[0].owner_id !== owner)
            throw new TransferError();
        destinationKey = transferHash({ host: options.database.host, port: options.database.port, database: identity.database, oid: identity.oid, ownerId: owner });
        const state = (await client.query('SELECT state,active_restore_run_id,manifest_hash FROM career.maintenance_state WHERE singleton AND owner_id=$1', [owner])).rows;
        if (state.length !== 1)
            throw new TransferError();
        const activeCredentials = await client.query('SELECT id FROM career.agent_credentials WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) LIMIT 1');
        if (activeCredentials.rowCount)
            throw new TransferError();
        const ephemeral = await client.query('SELECT id FROM career.mutation_keys LIMIT 1');
        if (ephemeral.rowCount)
            throw new TransferError();
        if ((await client.query("SELECT id FROM career.creation_requests WHERE entity_type='agent_credential' LIMIT 1")).rowCount)
            throw new TransferError();
        if (inspectForeign && (await client.query('SELECT 1 FROM career_maintenance.retired_identities WHERE owner_id<>$1 LIMIT 1',[owner])).rowCount)
            throw new TransferError();
        if (inspectForeign)
            for (const table of TRANSFER_TABLES) {
                if ((await client.query(`SELECT id FROM career.${table} WHERE owner_id<>$1 LIMIT 1`, [owner])).rowCount)
                    throw new TransferError();
            }
        return state[0] as {
            state: string;
            active_restore_run_id: string | null;
            manifest_hash: string | null;
        };
    };
    const checkRun = async (inspectForeign = true): Promise<Run> => {
        const state = await controls(inspectForeign);
        const result = (await client.query<Run>('SELECT id,state,manifest_hash,destination_key,expected_rows::text,restored_rows::text FROM career.restore_runs WHERE owner_id=$1 AND id=$2', [owner, runId])).rows;
        const run = result[0];
        if (result.length !== 1 || !run || run.manifest_hash !== manifestHash || run.destination_key !== destinationKey || Number(run.expected_rows) !== rows.length)
            throw new TransferError();
        if (run.state === 'completed' ? state.state !== 'ready' || state.active_restore_run_id !== null : state.state !== 'restoring' || state.active_restore_run_id !== runId || state.manifest_hash !== manifestHash || run.state !== 'restoring')
            throw new TransferError();
        await client.query("SELECT set_config('app.restore_run_id',$1,true)", [runId]);
        return run;
    };
    const usableFloor = async (tx: Transaction, verified: Snapshot) => {
        const floor = restoreDisplayFloor(verified, BigInt(await readDisplayHighWater(tx)));
        if (!hasDisplayCapacity(floor)) throw new RestoreSequenceExhaustedError();
        return floor;
    };
    const verifyContinuity = async (tx: Transaction, requiredFloor = restoreDisplayFloor(snapshot)) => {
        const observed = await readTransferContinuity(tx, owner);
        if (!continuity || BigInt(observed.displayHighWater) < requiredFloor || !hasDisplayCapacity(BigInt(observed.displayHighWater))
            || transferHash(observed.retiredClients) !== transferHash(continuity.retiredClients)
            || transferHash(observed.retiredKeys) !== transferHash(continuity.retiredKeys)) throw new TransferError();
    };
    const verifyExisting = async (completed = false) => {
        if (completed) await verifyContinuity(client);
        const ledger = (await client.query<{
            table_name: string;
            row_id: string;
            row_hash: string;
        }>('SELECT table_name,row_id,row_hash FROM career.restore_row_ledger WHERE owner_id=$1 AND restore_run_id=$2', [owner, runId])).rows;
        const recorded = new Map(ledger.map((row) => [row.table_name + '/' + row.row_id, row.row_hash]));
        const existing = await readTransferRows(client);
        let summaryCount = 0;
        for (const row of existing) {
            if (completed && row.table === 'audit_log' && row.data.id === runId) {
                if (row.data.source !== 'private-restore/v1' || row.data.operation !== 'restore' || row.data.entityType !== 'restore_runs' || row.data.entityId !== runId || transferHash(row.data.afterData) !== transferHash({ manifestHash, sourceOwnerId: snapshot.manifest.sourceOwnerId, destinationOwnerId: owner }))
                    throw new TransferError();
                summaryCount++;
                continue;
            }
            const key = row.table + '/' + row.data.id;
            if (recorded.get(key) !== expected.get(key) || expected.get(key) !== transferHash(row))
                throw new TransferError();
            recorded.delete(key);
        }
        if (recorded.size || ledger.length !== existing.length - summaryCount || completed && (summaryCount !== 1 || ledger.length !== rows.length))
            throw new TransferError();
        return new Set(ledger.map((row) => row.table_name + '/' + row.row_id));
    };
    try {
        await client.connect();
        const initial = await transact(async () => {
            const state = await controls();
            await preflightTransfer(client, owner, snapshot);
            if (continuity) await usableFloor(client, snapshot);
            if (options.mode === 'resume') {
                const run = await checkRun();
                const done = await verifyExisting(run.state === 'completed');
                if (Number(run.restored_rows) !== done.size)
                    throw new TransferError();
                persisted = true;
                return { done, completed: run.state === 'completed' };
            }
            // Mesmo arquivo após morte do processo: descubra somente a execução vinculada.
            if (options.mode === 'apply' && state.state === 'restoring' && state.active_restore_run_id) {
                runId = state.active_restore_run_id;
                const run = await checkRun();
                const done = await verifyExisting();
                if (Number(run.restored_rows) !== done.size) throw new TransferError();
                persisted = true;
                return { done, completed: false };
            }
            if (state.state !== 'ready' || state.active_restore_run_id !== null)
                throw new TransferError();
            if ((await readTransferRows(client)).length) {
                if (options.mode !== 'apply') throw new TransferError();
                const matches = (await client.query<{ id: string }>(`SELECT id FROM career.restore_runs WHERE owner_id=$1
                  AND destination_owner_id=$1 AND manifest_hash=$2 AND destination_key=$3 AND state='completed'`, [owner, manifestHash, destinationKey])).rows;
                if (matches.length !== 1) throw new TransferError();
                runId = matches[0]!.id;
                const run = await checkRun();
                const done = await verifyExisting(true);
                if (Number(run.restored_rows) !== done.size) throw new TransferError();
                persisted = true;
                return { done, completed: true };
            }
            if ((await client.query('SELECT 1 FROM career_maintenance.retired_identities LIMIT 1')).rowCount)
                throw new TransferError();
            if (options.mode === 'preview')
                return { done: new Set<string>(), completed: false };
            // Nenhuma linha histórica é inserida antes destes controles persistirem.
            await client.query(`INSERT INTO career.restore_runs(id,owner_id,destination_owner_id,manifest_hash,format_version,state,expected_rows,destination_key) VALUES($1,$2,$2,$3,1,'restoring',$4,$5)`, [runId, owner, manifestHash, rows.length, destinationKey]);
            await client.query("UPDATE career.maintenance_state SET state='restoring',active_restore_run_id=$2,manifest_hash=$3,version=version+1,updated_at=now() WHERE owner_id=$1", [owner, runId, manifestHash]);
            newStart = true;
            return { done: new Set<string>(), completed: false };
        });
        if (options.mode === 'preview')
            return { runId: null, state: continuity ? 'preview' : 'preview-continuity-required' };
        persisted = true;
        if (initial.completed)
            return { runId, state: 'completed' };
        const pending = rows.filter((row) => !initial.done.has(row.table + '/' + row.data.id));
        for (let start = 0; start < pending.length; start += chunkSize) {
            await transact(async (tx) => {
                await checkRun(false);
                const chunk = pending.slice(start, start + chunkSize);
                const committed = (await tx.query<{
                    table_name: string;
                    row_id: string;
                    row_hash: string;
                }>(`SELECT l.table_name,l.row_id,l.row_hash FROM career.restore_row_ledger l
          JOIN unnest($3::text[],$4::uuid[]) AS keys(table_name,row_id) ON keys.table_name=l.table_name AND keys.row_id=l.row_id
          WHERE l.owner_id=$1 AND l.restore_run_id=$2`, [owner, runId, chunk.map((row) => row.table), chunk.map((row) => row.data.id)])).rows;
                for (const row of committed)
                    if (expected.get(row.table_name + '/' + row.row_id) !== row.row_hash)
                        throw new TransferError();
                const done = new Set(committed.map((row) => row.table_name + '/' + row.row_id));
                for (const row of chunk) {
                    const key = row.table + '/' + row.data.id;
                    if (done.has(key))
                        continue;
                    await insertTransferRow(tx, owner, row);
                    await tx.query('INSERT INTO career.restore_row_ledger(owner_id,restore_run_id,table_name,row_id,row_hash) VALUES($1,$2,$3,$4,$5)', [owner, runId, row.table, row.data.id, expected.get(key)]);
                }
                await tx.query('UPDATE career.restore_runs SET restored_rows=(SELECT count(*) FROM career.restore_row_ledger WHERE owner_id=$1 AND restore_run_id=$2),version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2', [owner, runId]);
            });
            await options.afterChunk?.(start + Math.min(chunkSize, pending.length - start));
        }
        await transact(async (tx) => {
            await checkRun();
            const done = await verifyExisting();
            if (done.size !== rows.length)
                throw new TransferError();
            // Revalide todas as entidades e FKs antes da única ativação final.
            const actual = await readTransferRows(tx, owner);
            const verified = validateSnapshot({ manifest: snapshot.manifest, entities: actual });
            const floor = await usableFloor(tx, verified);
            if (!continuity) throw new RestoreContinuityRequiredError();
            await tx.query(`INSERT INTO career_maintenance.retired_identities(owner_id,kind,digest)
              SELECT $1::uuid,'client',unnest($2::text[]) UNION ALL SELECT $1::uuid,'key',unnest($3::text[])`,
              [owner,continuity.retiredClients,continuity.retiredKeys]);
            await tx.query(`SELECT setval('career.application_display_sequence',$1::bigint,true)
              FROM career.application_display_sequence
              WHERE $1::bigint > CASE WHEN is_called THEN last_value ELSE last_value-1 END`,[floor.toString()]);
            await verifyContinuity(tx, floor);
            await tx.query(`INSERT INTO career.audit_log(id,owner_id,actor_kind,actor_id,source,entity_type,entity_id,operation,before_data,after_data,diff,request_id)
        VALUES($1,$2::uuid,'owner',$2::uuid::text,'private-restore/v1','restore_runs',$1,'restore',NULL,$3,'{}',$1)`, [runId, owner, { manifestHash, sourceOwnerId: snapshot.manifest.sourceOwnerId, destinationOwnerId: owner }]);
            await tx.query('UPDATE career.restore_row_ledger SET verified_at=now(),version=version+1,updated_at=now() WHERE owner_id=$1 AND restore_run_id=$2', [owner, runId]);
            await tx.query("UPDATE career.restore_runs SET state='completed',verified_at=now(),version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [owner, runId]);
            await tx.query("UPDATE career.maintenance_state SET state='ready',active_restore_run_id=NULL,manifest_hash=NULL,version=version+1,updated_at=now() WHERE owner_id=$1", [owner]);
        });
        return { runId, state: 'completed' };
    }
    catch (error) {
        if (transactionActive)
            await client.query('ROLLBACK').catch(() => undefined);
        if (error instanceof RestoreSequenceExhaustedError) {
            if (options.mode === 'preview') return {runId:null,state:'preview-sequence-exhausted'};
            throw error;
        }
        if (persisted)
            throw new RestoreInterruptedError(runId);
        const code = (error as { code?: string } | null)?.code ?? '';
        const confirmedAbort = code.startsWith('23') || ['40001', '40P01', '25P02'].includes(code);
        if (startCommitAttempted && !confirmedAbort) throw new RestoreStartUncertainError(runId);
        throw new TransferError();
    }
    finally {
        await client.end().catch(() => undefined);
    }
}
export function readMaintenanceConfig(env: NodeJS.ProcessEnv): pg.ClientConfig {
    try {
        const url = new URL(env.PRIVATE_RESTORE_DATABASE_URL ?? '');
        const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password), database = decodeURIComponent(url.pathname.slice(1));
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !/^career_restore(?:\.[a-z0-9-]+)?$/.test(user) || !password || !database || database.includes('/') || !url.hostname)
            throw new TransferError();
        const port = Number(url.port || 5432);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new TransferError();
        const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['test', 'development'].includes(env.NODE_ENV ?? '');
        const disable = env.PRIVATE_RESTORE_DATABASE_TLS === 'disable-local';
        if (disable ? !local : env.PRIVATE_RESTORE_DATABASE_TLS !== 'verify-full')
            throw new TransferError();
        return { host: url.hostname === '[::1]' ? '::1' : url.hostname, port, user, password, database, ssl: disable ? false : { rejectUnauthorized: true, ...(env.PRIVATE_RESTORE_DATABASE_CA_CERT ? { ca: env.PRIVATE_RESTORE_DATABASE_CA_CERT } : {}) }, connectionTimeoutMillis: 5000, statement_timeout: 30000, application_name: 'career-tracker-restore' };
    }
    catch {
        throw new TransferError();
    }
}
export async function restorePrivateMain(args: string[], env: NodeJS.ProcessEnv = process.env) {
    const mode = args[0];
    if (!['preview', 'apply', 'resume'].includes(mode ?? ''))
        throw new TransferError();
    let file: string | undefined, runId: string | undefined, reassignOwner: string | undefined;
    for (let index = 1; index < args.length; index += 2) {
        const key = args[index], value = args[index + 1];
        if (!value || value.startsWith('--'))
            throw new TransferError();
        if (key === '--file' && file === undefined)
            file = value;
        else if (key === '--run-id' && runId === undefined)
            runId = value;
        else if (key === '--reassign-owner' && reassignOwner === undefined)
            reassignOwner = value;
        else
            throw new TransferError();
    }
    if (!file || !env.OWNER_SESSION_TOKEN)
        throw new TransferError();
    const snapshot = await readPrivateSnapshot(file);
    const config = readServerConfig(env);
    const actor = await createHumanAuthenticator(config)('Bearer ' + env.OWNER_SESSION_TOKEN);
    return restorePrivate({ database: readMaintenanceConfig(env), ownerId: config.ownerUserId, actor, snapshot, mode: mode as RestoreOptions['mode'], runId, reassignOwner });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    restorePrivateMain(process.argv.slice(2)).then(result => console.log(result.state === 'preview-sequence-exhausted'
        ? new RestoreSequenceExhaustedError().message : result.state === 'preview-continuity-required'
        ? new RestoreContinuityRequiredError().message : result.state === 'preview' ? 'Prévia válida; destino vazio, nenhuma linha restaurada.' : 'Restauração verificada e ativada. Run: ' + result.runId))
        .catch((error: unknown) => { console.error(error instanceof RestoreContinuityRequiredError || error instanceof RestoreSequenceExhaustedError ? error.message : error instanceof RestoreStartUncertainError ? 'Confirmação inicial incerta. Reexecute apply com o mesmo arquivo; ele confere a execução persistida. Handle: ' + error.runId : error instanceof RestoreInterruptedError ? 'Restauração interrompida; não libere a manutenção. Retome o mesmo arquivo com --run-id ' + error.runId : 'Falha na restauração privada. Confira sessão, destino, manifesto e ocupação; nenhuma informação privada foi exibida.'); process.exitCode = 1; });
}
