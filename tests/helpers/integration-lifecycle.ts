import { runLocalDatabase } from '../../scripts/local-db';
import { auditDedicatedDatabases } from '../../scripts/audit-local';

export default async function setup() {
  // Restore-dependent files may run in any order, including on a fresh cluster.
  await runLocalDatabase('apply', process.env.LOCAL_RESTORE_TEST_DATABASE_URL);
  await auditDedicatedDatabases();
  return async () => { await auditDedicatedDatabases(); };
}
