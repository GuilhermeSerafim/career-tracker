import { buildSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS, TRANSFER_TABLES, TransferError, type Snapshot, type TransferTable } from '../../domain/export.js';
import { transferDataKeys, type TransferEntity } from '../../shared/transfer.js';
import type { Transaction } from '../database';
import type { PreviousImportState } from '../../domain/import';

export interface AppliedImportState extends PreviousImportState {
  originalText: string;
  resolution: { appliedInterpretation: Record<string, unknown> };
}

/** Cada aplicação/reconciliação serializada avança a versão; skips não criam outro estado aplicado.
 * Hash, versão, original e interpretação vêm da mesma linha, sem inferir ordem por relógio/UUID. */
export async function loadAppliedImportStates(transaction: Transaction, ownerId: string): Promise<AppliedImportState[]> {
  const result = await transaction.query<{ legacy_id: string; row_hash: string; applied_target_version: number; version: number; original_text: string; resolution: AppliedImportState['resolution'] }>(`SELECT DISTINCT ON (r.legacy_id) r.legacy_id,r.row_hash,r.applied_target_version,a.version,r.original_text,r.resolution
    FROM career.import_rows r JOIN career.applications a ON a.owner_id=r.owner_id AND a.id=r.target_application_id
    WHERE r.owner_id=$1 AND r.result='imported' AND r.applied_target_version IS NOT NULL
    ORDER BY r.legacy_id,r.applied_target_version DESC`, [ownerId]);
  return result.rows.map((row) => ({ legacyId: row.legacy_id, rawRowHash: row.row_hash, importedApplicationVersion: row.applied_target_version, currentApplicationVersion: row.version, originalText: row.original_text, resolution: row.resolution }));
}

/** Somente estado persistido; a base enviada no preview não autoriza atualização. */
export async function loadImportBasis(transaction: Transaction, ownerId: string): Promise<PreviousImportState[]> {
  return (await loadAppliedImportStates(transaction, ownerId)).map(({ legacyId, rawRowHash, importedApplicationVersion, currentApplicationVersion }) => ({ legacyId, rawRowHash, importedApplicationVersion, currentApplicationVersion }));
}

/** Lista fechada do contrato: credenciais, controles e colunas derivadas ficam fora. */
export const TRANSFER_FIELDS = Object.fromEntries(TRANSFER_TABLES.map((table) => [table, transferDataKeys(table)])) as Record<TransferTable, string[]>;
export const sqlColumn = (field: string) => field.replace(/[A-Z]/g, (char) => '_' + char.toLowerCase());
export const transferProjection = (table: TransferTable) => 'jsonb_build_object(' + TRANSFER_FIELDS[table].flatMap((field) => {
  const value = field === 'actor' ? "jsonb_build_object('kind',t.actor_kind,'id',t.actor_id)" : field === 'originalBytesBase64' ? "replace(encode(t.original_bytes,'base64'),E'\\n','')" : `t.${sqlColumn(field)}`;
  return [`'${field}'`, value];
}).join(',') + ')';
/** Uma única instrução SQL: todas as tabelas e o orçamento observam o mesmo snapshot. */
export async function readTransferRows(tx: Transaction, ownerId?: string): Promise<TransferEntity[]> {
  await tx.query("SET LOCAL TIME ZONE 'UTC'");
  const union = TRANSFER_TABLES.map((table) => {
    const conditions = [...(ownerId ? ['t.owner_id=$1'] : []), ...(table === 'creation_requests' ? ["t.entity_type<>'agent_credential'"] : [])];
    return `SELECT '${table}'::text AS table, ${transferProjection(table)} AS data FROM career.${table} t ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}`;
  }).join(' UNION ALL ');
  const result = await tx.query<{ table: TransferTable | null; data: TransferEntity['data'] | null; count: string; bytes: string }>(`WITH history AS MATERIALIZED (${union}), budget AS (SELECT count(*) AS count,coalesce(sum(octet_length(data::text)+100),0) AS bytes FROM history)
    SELECT h.*,b.count::text,b.bytes::text FROM budget b LEFT JOIN LATERAL (SELECT * FROM history WHERE b.count<=${MAX_SNAPSHOT_ROWS} AND b.bytes<=${MAX_SNAPSHOT_BYTES - 20000}) h ON true`, ownerId ? [ownerId] : []);
  if (Number(result.rows[0]?.count ?? 0) > MAX_SNAPSHOT_ROWS || Number(result.rows[0]?.bytes ?? 0) > MAX_SNAPSHOT_BYTES - 20000) throw new TransferError();
  return result.rows.filter((row) => row.table !== null).map(({ table, data }) => ({ formatVersion: 1, table, data }) as TransferEntity);
}
export async function readSnapshot(tx: Transaction, ownerId: string): Promise<Snapshot> {
  return buildSnapshot(ownerId, await readTransferRows(tx, ownerId));
}
export function transferRecord(ownerId: string, row: TransferEntity): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>;
  record.owner_id = ownerId;
  for (const [key, value] of Object.entries(row.data)) {
    if (!TRANSFER_FIELDS[row.table].includes(key)) throw new TransferError();
    if (key === 'actor') { const actor = value as { kind: string; id: string }; record.actor_kind = actor.kind; record.actor_id = actor.id; }
    else if (key === 'originalBytesBase64') record.original_bytes = '\\x' + Buffer.from(value as string, 'base64').toString('hex');
    else record[sqlColumn(key)] = value;
  }
  return record;
}
export async function insertTransferRow(tx: Transaction, ownerId: string, row: TransferEntity): Promise<void> {
  const record = transferRecord(ownerId, row);
  const columns = Object.keys(record);
  await tx.query(`INSERT INTO career.${row.table} (${columns.join(',')}) SELECT ${columns.join(',')} FROM jsonb_populate_record(NULL::career.${row.table},$1::jsonb)`, [JSON.stringify(record)]);
}
