import type { createDatabase } from '../database';
import type { AuthenticatedOwner } from '../auth';
import { readSnapshot } from '../repositories/transfers';
import { snapshotCsv } from '../../domain/export';
export function createExportService(database: ReturnType<typeof createDatabase>) {
    const json = (actor: AuthenticatedOwner) => database.transaction(actor, (tx) => readSnapshot(tx, actor.ownerId));
    return { json, csv: async (actor: AuthenticatedOwner) => snapshotCsv(await json(actor)) };
}
