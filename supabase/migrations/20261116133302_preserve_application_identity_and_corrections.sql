-- Normalização limitada e idêntica ao domínio TypeScript: ASCII whitespace e NBSP.
-- O índice novo rejeita colisões existentes; nenhuma linha é fundida silenciosamente.
DROP INDEX career.applications_canonical_identity;
ALTER TABLE career.applications DROP COLUMN normalized_track;
ALTER TABLE career.applications ADD COLUMN normalized_track text GENERATED ALWAYS AS
  (btrim(regexp_replace(coalesce(track,''), E'[ \\t\\n\\r\\f\\013\\u00a0]+', ' ', 'g'))) STORED NOT NULL;
CREATE UNIQUE INDEX applications_canonical_identity ON career.applications(owner_id,opportunity_id,normalized_track,application_instance) WHERE canonical_application_id IS NULL;
ALTER TABLE career.application_resumes ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE career.batches ADD COLUMN rectification_pending boolean NOT NULL DEFAULT false;
ALTER TABLE career.creation_requests ADD COLUMN result_resume_id uuid;
ALTER TABLE career.creation_requests ADD COLUMN result_evidence_id uuid;
-- Substitui somente o conjunto de tipos e a cardinalidade do resultado.
-- Os CHECKs existentes de correspondência dos cinco tipos permanecem intactos.
ALTER TABLE career.creation_requests DROP CONSTRAINT creation_requests_entity_type_check;
ALTER TABLE career.creation_requests DROP CONSTRAINT creation_requests_check;
ALTER TABLE career.creation_requests
  ADD CHECK (entity_type IN ('application','contact','task','event','agent_credential','resume_ref','evidence')),
  ADD CHECK (num_nonnulls(result_application_id,result_contact_id,result_task_id,result_event_id,result_credential_id,result_resume_id,result_evidence_id)=1),
  ADD CHECK ((entity_type='resume_ref')=(result_resume_id IS NOT NULL)),
  ADD CHECK ((entity_type='evidence')=(result_evidence_id IS NOT NULL)),
  ADD FOREIGN KEY (owner_id,result_resume_id) REFERENCES career.resume_refs(owner_id,id),
  ADD FOREIGN KEY (owner_id,result_evidence_id) REFERENCES career.evidence(owner_id,id);
