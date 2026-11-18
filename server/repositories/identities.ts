import type { Transaction } from '../database';
import { SafeError } from '../errors.js';

/** Mesmo namespace, normalização e exclusão mútua em todas as rotas de criação. */
export async function lockApplicationIdentity(transaction: Transaction, ownerId: string) {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`career.application-identity:${ownerId}`]);
}
export async function resolveOpportunityIdentity(transaction: Transaction, ownerId: string, identities: readonly { provider: string; tenant: string; kind: string; value: string }[]) {
  const targets = new Set<string>();
  for (const identity of identities) {
    const rows = await transaction.query<{ opportunity_id: string }>(`SELECT opportunity_id FROM career.opportunity_identities WHERE owner_id=$1 AND normalized_provider=lower(btrim($2)) AND normalized_tenant=btrim($3) AND identity_kind=$4 AND normalized_value=btrim($5)`, [ownerId, identity.provider, identity.tenant, identity.kind, identity.value]);
    rows.rows.forEach((row) => targets.add(row.opportunity_id));
  }
  if (targets.size > 1) throw new SafeError('CONFLICT');
  return [...targets][0];
}
