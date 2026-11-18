ALTER TABLE career.cycles ADD COLUMN is_current boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX cycles_current_owner ON career.cycles(owner_id) WHERE is_current;
ALTER TABLE career.creation_requests ADD COLUMN result_cycle_id uuid;
ALTER TABLE career.creation_requests DROP CONSTRAINT creation_requests_entity_type_check;
ALTER TABLE career.creation_requests DROP CONSTRAINT creation_requests_check;
ALTER TABLE career.creation_requests
  ADD CHECK (entity_type IN ('application','contact','task','event','agent_credential','resume_ref','evidence','cycle')),
  ADD CHECK (num_nonnulls(result_application_id,result_contact_id,result_task_id,result_event_id,result_credential_id,result_resume_id,result_evidence_id,result_cycle_id)=1),
  ADD CHECK ((entity_type='cycle')=(result_cycle_id IS NOT NULL)),
  ADD FOREIGN KEY (owner_id,result_cycle_id) REFERENCES career.cycles(owner_id,id);
ALTER TABLE career.review_versions ADD COLUMN calculation_version text;
ALTER TABLE career.review_versions ADD COLUMN closed_at timestamptz;
ALTER TABLE career.review_versions ADD COLUMN reason text;
ALTER TABLE career.review_versions ADD COLUMN evidence_id uuid;
ALTER TABLE career.review_versions ADD COLUMN original_markdown text;
ALTER TABLE career.review_versions ADD COLUMN import_provenance jsonb;
ALTER TABLE career.review_versions ADD FOREIGN KEY (owner_id,evidence_id) REFERENCES career.evidence(owner_id,id);

-- Mesma ordem dos serviços/correções: candidatura antes do lote, inclusive DML direto.
CREATE FUNCTION career.guard_membership_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, career, pg_temp AS $$
DECLARE batch_status text; app career.applications;
BEGIN
  IF session_user='career_restore' THEN
    IF career.restore_insert_allowed(NEW.owner_id) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Restauração não autorizada.' USING ERRCODE='23514';
  END IF;
  SELECT * INTO app FROM career.applications WHERE owner_id=NEW.owner_id AND id=NEW.application_id FOR UPDATE;
  SELECT status INTO batch_status FROM career.batches WHERE owner_id=NEW.owner_id AND id=NEW.batch_id FOR UPDATE;
  IF batch_status='closed' THEN RAISE EXCEPTION 'Lote fechado.' USING ERRCODE='23514'; END IF;
  IF session_user='career_api' AND (app.id IS NULL OR app.submission_status<>'confirmado' OR NOT app.counting_eligible OR app.canonical_application_id IS NOT NULL OR app.cycle_relation<>'after_reset') THEN
    RAISE EXCEPTION 'Candidatura inelegível.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION career.guard_membership_insert() OWNER TO career_schema_owner;
REVOKE ALL ON FUNCTION career.guard_membership_insert() FROM PUBLIC;
CREATE TRIGGER batch_members_insert_guard BEFORE INSERT ON career.batch_members FOR EACH ROW EXECUTE FUNCTION career.guard_membership_insert();
