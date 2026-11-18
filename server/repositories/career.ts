import { applicationProjectionSchema, resumeRefSchema } from '../../shared/application-results.js';
import type { Transaction } from '../database';
import { SafeError } from '../errors.js';

/** Projeções só são executadas dentro de transações autenticadas com gate/RLS. */
export async function listResumeRefs(transaction: Transaction, ownerId: string) {
  const rows = await transaction.query(`SELECT id,version,label,stack,language,local_ref AS "localRef"
    FROM career.resume_refs WHERE owner_id=$1 ORDER BY created_at,id`, [ownerId]);
  return rows.rows.map((row) => resumeRefSchema.parse(row));
}

export async function applicationProjection(transaction: Transaction, ownerId: string, id: string) {
  const result = await transaction.query(`SELECT a.id,a.version,a.display_id AS "displayId",a.track,
    a.application_instance AS "applicationInstance",a.notes,a.submission_status AS "submissionStatus",
    a.submitted_date AS "submittedDate",a.counting_eligible AS "countingEligible",a.canonical_application_id AS "canonicalApplicationId",
    a.stage,a.archived_at AS "archivedAt",a.cycle_relation AS "cycleRelation",a.cycle_order AS "cycleOrder",
    a.discovery_channel AS "discoveryChannel",a.submission_platform AS "submissionPlatform",o.stack,
    jsonb_build_object('id',o.id,'version',o.version,'company',o.company,'title',o.title,'platform',o.platform,'tenant',o.tenant,'jobCode',o.job_code,'jobKey',o.job_key,'kind',o.kind,'seniority',o.seniority,'modality',o.modality,'description',o.description,'stack',o.stack) AS opportunity,
    ARRAY(SELECT resume_id FROM career.application_resumes r WHERE r.owner_id=a.owner_id AND r.application_id=a.id AND r.is_active ORDER BY resume_id) AS "resumeIds"
    FROM career.applications a JOIN career.opportunities o ON o.owner_id=a.owner_id AND o.id=a.opportunity_id
    WHERE a.owner_id=$1 AND a.id=$2`, [ownerId, id]);
  const row = result.rows[0]; if (!row) throw new SafeError('NOT_FOUND');
  // Uma resolução mantém IDs e todos os eventos originais consultáveis pela candidatura canônica.
  const history = await transaction.query<{ id: string }>(`WITH RECURSIVE history AS (
    SELECT id FROM career.applications WHERE owner_id=$1 AND id=$2
    UNION SELECT a.id FROM career.applications a JOIN history h ON a.canonical_application_id=h.id WHERE a.owner_id=$1
    ) SELECT id FROM history ORDER BY id`, [ownerId, id]);
  const historyApplicationIds = history.rows.map((item) => item.id);
  const events = await transaction.query<{ id: string }>('SELECT id FROM career.events WHERE owner_id=$1 AND application_id=ANY($2::uuid[]) ORDER BY created_at,id', [ownerId, historyApplicationIds]);
  return applicationProjectionSchema.parse({ ...row, archivedAt: row.archivedAt instanceof Date ? row.archivedAt.toISOString() : row.archivedAt,
    cycleOrder: row.cycleOrder === null ? null : Number(row.cycleOrder), historyApplicationIds, eventIds: events.rows.map((event) => event.id) });
}
