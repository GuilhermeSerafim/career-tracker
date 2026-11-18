-- Auditoria das operações da aplicação. O administrador da migration é fixado na
-- configuração da função; edição direta pelo DBA fica fora desta garantia.
GRANT USAGE ON SCHEMA career TO career_audit_writer;
GRANT INSERT ON career.audit_log TO career_audit_writer;
GRANT SELECT (singleton,owner_id) ON career.owner_config TO career_audit_writer;
GRANT SELECT (singleton,owner_id,state,active_restore_run_id,manifest_hash) ON career.maintenance_state TO career_audit_writer;
GRANT SELECT (id,owner_id,destination_owner_id,manifest_hash,state) ON career.restore_runs TO career_audit_writer;
CREATE POLICY audit_owner_metadata ON career.owner_config FOR SELECT TO career_audit_writer USING (singleton);
CREATE POLICY audit_maintenance_metadata ON career.maintenance_state FOR SELECT TO career_audit_writer USING (singleton);
CREATE POLICY audit_restore_metadata ON career.restore_runs FOR SELECT TO career_audit_writer
  USING (owner_id=(SELECT owner_id FROM career.owner_config WHERE singleton));
CREATE POLICY audit_writer_insert ON career.audit_log FOR INSERT TO career_audit_writer WITH CHECK (
  owner_id=(SELECT owner_id FROM career.owner_config WHERE singleton)
  AND owner_id::text=nullif(current_setting('app.owner_id',true),'')
  AND EXISTS (SELECT FROM career.maintenance_state WHERE singleton AND maintenance_state.owner_id=audit_log.owner_id AND state='ready')
);

CREATE FUNCTION career.audit_business_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, career, pg_temp AS $$
DECLARE
  before_row jsonb; after_row jsonb; changes jsonb; row_owner uuid; row_id uuid;
  actor_kind_value text := nullif(current_setting('app.actor_kind',true),'');
  actor_id_value text := nullif(current_setting('app.actor_id',true),'');
  source_value text := nullif(current_setting('app.source',true),'');
  request_value text := nullif(current_setting('app.request_id',true),'');
BEGIN
  row_owner := CASE WHEN TG_OP='DELETE' THEN OLD.owner_id ELSE NEW.owner_id END;
  row_id := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF session_user = current_setting('app.audit_admin') THEN
    -- Fixtures/DDL do DBA não são operações runtime. Provisionamento é explícito.
    IF source_value IS DISTINCT FROM 'provisioning' THEN RETURN NULL; END IF;
    IF actor_kind_value IS DISTINCT FROM 'owner' OR actor_id_value IS DISTINCT FROM row_owner::text THEN
      RAISE EXCEPTION 'Contexto de provisionamento inválido.' USING ERRCODE='42501';
    END IF;
  ELSIF session_user='career_restore' THEN
    IF TG_OP='INSERT' AND EXISTS (
      SELECT FROM career.restore_runs r JOIN career.maintenance_state m
        ON m.owner_id=r.owner_id AND m.active_restore_run_id=r.id AND m.manifest_hash=r.manifest_hash
      JOIN career.owner_config c ON c.singleton AND c.owner_id=r.owner_id
      WHERE m.singleton AND m.state='restoring' AND r.state='restoring'
        AND r.owner_id=row_owner AND r.destination_owner_id=row_owner
        AND r.id::text=nullif(current_setting('app.restore_run_id',true),'')
    ) THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'Restauração não autorizada.' USING ERRCODE='42501';
  ELSIF session_user <> 'career_api' THEN
    RAISE EXCEPTION 'Principal não autorizado.' USING ERRCODE='42501';
  END IF;
  IF actor_kind_value IS NULL OR actor_kind_value NOT IN ('owner','agent','import')
    OR actor_id_value IS NULL OR length(actor_id_value)>200
    OR source_value IS NULL OR length(source_value)>100
    OR request_value IS NULL OR request_value !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR (actor_kind_value='owner' AND actor_id_value<>row_owner::text)
    OR (session_user='career_api' AND source_value='provisioning') THEN
    RAISE EXCEPTION 'Contexto de auditoria inválido.' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='agent_credentials' THEN
    -- Projetar antes da construção de JSON: nenhum segredo entra no snapshot/diff.
    IF TG_OP<>'INSERT' THEN
      SELECT to_jsonb(safe) INTO before_row FROM (SELECT OLD.id,OLD.owner_id,OLD.label,OLD.prefix,OLD.scopes,
        OLD.expires_at,OLD.revoked_at,OLD.created_at,OLD.updated_at,OLD.version) safe;
    END IF;
    IF TG_OP<>'DELETE' THEN
      SELECT to_jsonb(safe) INTO after_row FROM (SELECT NEW.id,NEW.owner_id,NEW.label,NEW.prefix,NEW.scopes,
        NEW.expires_at,NEW.revoked_at,NEW.created_at,NEW.updated_at,NEW.version) safe;
    END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN before_row := to_jsonb(OLD); END IF;
    IF TG_OP<>'DELETE' THEN after_row := to_jsonb(NEW); END IF;
  END IF;
  SELECT coalesce(jsonb_object_agg(key,jsonb_build_object('before',before_row->key,'after',after_row->key)),'{}'::jsonb)
    INTO changes FROM (SELECT jsonb_object_keys(coalesce(before_row,'{}') || coalesce(after_row,'{}')) AS key) keys
    WHERE (before_row->key) IS DISTINCT FROM (after_row->key);
  INSERT INTO career.audit_log(owner_id,actor_kind,actor_id,source,entity_type,entity_id,operation,before_data,after_data,diff,request_id)
    VALUES(row_owner,actor_kind_value,actor_id_value,source_value,TG_TABLE_NAME,row_id,lower(TG_OP),before_row,after_row,changes,request_value::uuid);
  RETURN NULL;
END;
$$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION career.audit_business_change() SET app.audit_admin = %L', session_user);
END $$;
ALTER FUNCTION career.audit_business_change() OWNER TO career_audit_writer;
REVOKE ALL ON FUNCTION career.audit_business_change() FROM PUBLIC,career_api,career_restore;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['owner_settings','opportunities','applications','contacts','links','resume_refs',
    'application_resumes','evidence','events','tasks','cycles','batches','batch_members','review_versions',
    'import_runs','source_files','import_rows','agent_credentials','opportunity_identities'] LOOP
    EXECUTE format('CREATE TRIGGER business_audit AFTER INSERT OR UPDATE OR DELETE ON career.%I FOR EACH ROW EXECUTE FUNCTION career.audit_business_change()',table_name);
  END LOOP;
END $$;

-- Reserva e conclusão permanecem na mesma transação. Somente os dois campos de
-- resposta podem mudar, uma única vez; a constraint diferida verifica o COMMIT.
GRANT UPDATE (http_status,safe_response) ON career.mutation_keys TO career_api;
CREATE POLICY runtime_complete ON career.mutation_keys FOR UPDATE TO career_api
  USING (career.runtime_owner(owner_id)) WITH CHECK (career.runtime_owner(owner_id));
CREATE FUNCTION career.preserve_mutation_reply() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, career, pg_temp AS $$
BEGIN
  IF OLD.http_status<>102 THEN RAISE EXCEPTION 'Resposta já concluída.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION career.require_completed_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, career, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM career.mutation_keys WHERE id=NEW.id AND owner_id=NEW.owner_id AND http_status BETWEEN 200 AND 299) THEN
    RAISE EXCEPTION 'Reserva incompleta.' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION career.preserve_mutation_reply() OWNER TO career_schema_owner;
ALTER FUNCTION career.require_completed_mutation() OWNER TO career_schema_owner;
REVOKE ALL ON FUNCTION career.preserve_mutation_reply(),career.require_completed_mutation() FROM PUBLIC,career_api,career_restore;
CREATE TRIGGER mutation_reply_immutable BEFORE UPDATE ON career.mutation_keys FOR EACH ROW EXECUTE FUNCTION career.preserve_mutation_reply();
CREATE CONSTRAINT TRIGGER mutation_reply_complete AFTER INSERT OR UPDATE ON career.mutation_keys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION career.require_completed_mutation();
