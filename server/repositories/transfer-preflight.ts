import { canonicalJson, TRANSFER_TABLES, TransferError, type Snapshot, type TransferTable } from '../../domain/export';
import type { Transaction } from '../database';
import { transferProjection, transferRecord } from './transfers';

const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
interface Column { table_name: TransferTable; name: string; required: boolean; generated: string | null }
interface Check { table_name: TransferTable; expression: string }
interface Unique { table_name: TransferTable; keys: string[]; predicate: string | null; nulls_equal: boolean }
interface Foreign { table_name: TransferTable; target: string; target_schema: string; keys: string[]; targets: string[] }

/** Somente SELECT: tipos e invariantes reais do catálogo revisado, antes de qualquer escrita.
 * SQL/identificadores vêm exclusivamente do catálogo das tabelas fixas; nunca do snapshot. */
export async function preflightTransfer(tx: Transaction, ownerId: string, snapshot: Snapshot): Promise<void> {
    const columns = (await tx.query<Column>(`SELECT c.relname AS table_name,a.attname AS name,a.attnotnull AS required,
      CASE WHEN a.attgenerated<>'' THEN pg_get_expr(d.adbin,d.adrelid) END AS generated
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='career' AND c.relname=ANY($1) ORDER BY c.relname,a.attnum`, [TRANSFER_TABLES])).rows;
    const checks = (await tx.query<Check>(`SELECT c.relname AS table_name,pg_get_expr(k.conbin,k.conrelid) AS expression
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='career' AND c.relname=ANY($1) AND k.contype='c'`, [TRANSFER_TABLES])).rows;
    const unique = (await tx.query<Unique>(`SELECT c.relname AS table_name,i.indnullsnotdistinct AS nulls_equal,
      pg_get_expr(i.indpred,i.indrelid) AS predicate,
      ARRAY(SELECT pg_get_indexdef(i.indexrelid,s,true) FROM generate_series(1,i.indnkeyatts) s) AS keys
      FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='career' AND c.relname=ANY($1) AND i.indisunique`, [TRANSFER_TABLES])).rows;
    const foreign = (await tx.query<Foreign>(`SELECT c.relname AS table_name,f.relname AS target,fn.nspname AS target_schema,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY q(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=q.attnum ORDER BY q.ord) AS keys,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY q(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=q.attnum ORDER BY q.ord) AS targets
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_class f ON f.oid=k.confrelid JOIN pg_namespace fn ON fn.oid=f.relnamespace
      WHERE n.nspname='career' AND c.relname=ANY($1) AND k.contype='f'`, [TRANSFER_TABLES])).rows;
    const parameters: string[] = [];
    const ctes: string[] = [];
    const projections: string[] = [];
    const uniqueness: string[] = [];
    const expected = new Map(snapshot.entities.map(row => [row.table + '/' + row.data.id, canonicalJson(row.data)]));
    for (const table of TRANSFER_TABLES) {
        const attrs = columns.filter(column => column.table_name === table);
        if (!attrs.length) throw new TransferError();
        parameters.push(JSON.stringify(snapshot.entities.filter(row => row.table === table).map(row => transferRecord(ownerId, row))));
        const raw = quote('raw_' + table), typed = quote('typed_' + table);
        ctes.push(`${raw} AS MATERIALIZED (SELECT * FROM jsonb_populate_recordset(NULL::career.${quote(table)},$${parameters.length}::jsonb))`);
        ctes.push(`${typed} AS MATERIALIZED (SELECT ${attrs.map(column => column.generated ? `(${column.generated}) AS ${quote(column.name)}` : quote(column.name)).join(',')} FROM ${raw})`);
        const conditions = [
            ...attrs.filter(column => column.required).map(column => `t.${quote(column.name)} IS NOT NULL`),
            ...checks.filter(check => check.table_name === table).map(check => `(${check.expression}) IS NOT FALSE`),
        ];
        for (const fk of foreign.filter(key => key.table_name === table)) {
            const nullable = fk.keys.map(key => `t.${quote(key)} IS NULL`).join(' OR ');
            const target = fk.target_schema === 'career' && TRANSFER_TABLES.includes(fk.target as TransferTable)
                ? `EXISTS(SELECT FROM ${quote('typed_' + fk.target)} p WHERE ${fk.keys.map((key, index) => `t.${quote(key)}=p.${quote(fk.targets[index]!)}`).join(' AND ')})`
                : 'false';
            conditions.push(`(${nullable} OR ${target})`);
        }
        for (const key of unique.filter(key => key.table_name === table)) {
            const predicates = [key.predicate ? `(${key.predicate}) IS TRUE` : 'true', ...(key.nulls_equal ? [] : key.keys.map(field => `(${field}) IS NOT NULL`))];
            uniqueness.push(`NOT EXISTS(SELECT FROM ${typed} WHERE ${predicates.join(' AND ')} GROUP BY ${key.keys.join(',')} HAVING count(*)>1)`);
        }
        projections.push(`SELECT '${table}'::text AS table_name,${transferProjection(table)} AS data,(${conditions.join(' AND ')}) AS row_valid FROM ${typed} t`);
    }
    ctes.push(`integrity AS (SELECT ${uniqueness.join(' AND ')} AS valid)`);
    const result = await tx.query<{ table_name: TransferTable; data: { id: string }; valid: boolean }>(`WITH ${ctes.join(',')}
      SELECT p.table_name,p.data,(p.row_valid AND integrity.valid) AS valid FROM (${projections.join(' UNION ALL ')}) p CROSS JOIN integrity`, parameters);
    if (result.rows.length !== snapshot.entities.length) throw new TransferError();
    for (const row of result.rows) {
        if (!row.valid || expected.get(row.table_name + '/' + row.data.id) !== canonicalJson(row.data)) throw new TransferError();
    }
}
