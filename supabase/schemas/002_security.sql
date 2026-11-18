-- Princípios separados. Senhas são fornecidas somente pelo provisionamento local.
DO $$
DECLARE role_name text; membership record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['career_schema_owner','career_api','career_restore','career_audit_writer'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I', role_name);
    END IF;
    EXECUTE format('ALTER ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
      role_name, CASE WHEN role_name IN ('career_api','career_restore') THEN 'LOGIN' ELSE 'NOLOGIN' END);
  END LOOP;
  -- NOINHERIT não impede SET ROLE: remover também associações preexistentes.
  FOR membership IN SELECT parent.rolname AS parent, child.rolname AS child
    FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member
    WHERE child.rolname IN ('career_api','career_restore','career_audit_writer','career_schema_owner')
  LOOP EXECUTE format('REVOKE %I FROM %I', membership.parent, membership.child); END LOOP;
END;
$$;

-- Leitura não recursiva da configuração; nenhuma função SECURITY DEFINER nesta etapa.
CREATE FUNCTION career.configured_owner() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, career, pg_temp AS $$
  SELECT owner_id FROM career.owner_config WHERE singleton;
$$;
CREATE FUNCTION career.runtime_owner(row_owner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, career, pg_temp AS $$
  SELECT row_owner = career.configured_owner()
    AND row_owner::text = nullif(current_setting('app.owner_id',true),'');
$$;
CREATE FUNCTION career.runtime_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, career, pg_temp AS $$
  SELECT EXISTS (SELECT FROM career.maintenance_state
    WHERE singleton AND owner_id=career.configured_owner() AND state='ready');
$$;
CREATE FUNCTION career.restore_insert_allowed(row_owner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, career, pg_temp AS $$
  SELECT row_owner = career.configured_owner() AND EXISTS (
    SELECT FROM career.restore_runs r JOIN career.maintenance_state m
      ON m.owner_id=r.owner_id AND m.active_restore_run_id=r.id AND m.manifest_hash=r.manifest_hash
    WHERE m.singleton AND m.state='restoring' AND r.state='restoring'
      AND r.owner_id=row_owner AND r.destination_owner_id=row_owner
      AND r.id::text=nullif(current_setting('app.restore_run_id',true),'')
  );
$$;

-- O restore tem INSERT, nunca UPDATE de negócio. SELECT posterior observa o vencedor
-- de ON CONFLICT no isolamento READ COMMITTED; aliases continuam exclusivos.
CREATE OR REPLACE FUNCTION career.register_opportunity_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE identity_target uuid;
BEGIN
  IF nullif(btrim(NEW.platform),'') IS NOT NULL AND nullif(btrim(NEW.tenant),'') IS NOT NULL AND nullif(btrim(NEW.job_code),'') IS NOT NULL THEN
    INSERT INTO career.opportunity_identities (owner_id,opportunity_id,provider,tenant,identity_kind,identity_value)
    VALUES (NEW.owner_id,NEW.id,NEW.platform,NEW.tenant,'job_code',NEW.job_code)
    ON CONFLICT (owner_id,normalized_provider,normalized_tenant,identity_kind,normalized_value) DO NOTHING;
    SELECT opportunity_id INTO identity_target FROM career.opportunity_identities
      WHERE owner_id=NEW.owner_id AND normalized_provider=lower(btrim(NEW.platform))
        AND normalized_tenant=btrim(NEW.tenant) AND identity_kind='job_code' AND normalized_value=btrim(NEW.job_code);
    IF identity_target IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'A identidade forte já pertence a outra oportunidade.' USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE item record; role_name text;
BEGIN
  FOR item IN SELECT c.relname,c.relkind FROM pg_class c WHERE c.relnamespace='career'::regnamespace AND c.relkind IN ('r','S') LOOP
    IF item.relkind='r' THEN
      EXECUTE format('ALTER TABLE career.%I OWNER TO career_schema_owner',item.relname);
      EXECUTE format('ALTER TABLE career.%I ENABLE ROW LEVEL SECURITY',item.relname);
      EXECUTE format('ALTER TABLE career.%I FORCE ROW LEVEL SECURITY',item.relname);
    ELSE EXECUTE format('ALTER SEQUENCE career.%I OWNER TO career_schema_owner',item.relname);
    END IF;
  END LOOP;
  FOR item IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='career'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO career_schema_owner',item.signature);
  END LOOP;
  FOR item IN SELECT typname FROM pg_type WHERE typnamespace='career'::regnamespace AND typtype='d' LOOP
    EXECUTE format('ALTER DOMAIN career.%I OWNER TO career_schema_owner',item.typname);
    EXECUTE format('REVOKE ALL ON TYPE career.%I FROM PUBLIC',item.typname);
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['PUBLIC','career_api','career_restore','career_audit_writer','anon','authenticated','service_role'] LOOP
    IF role_name='PUBLIC' OR EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA career FROM %s', CASE WHEN role_name='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(role_name) END);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA career FROM %s', CASE WHEN role_name='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(role_name) END);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA career FROM %s', CASE WHEN role_name='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(role_name) END);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA career FROM %s', CASE WHEN role_name='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(role_name) END);
    END IF;
  END LOOP;
END;
$$;
ALTER SCHEMA career OWNER TO career_schema_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE career_schema_owner IN SCHEMA career REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE career_schema_owner IN SCHEMA career REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE career_schema_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA career TO career_api,career_restore;
GRANT USAGE ON TYPE career.date_value,career.positive_version,career.sha256 TO career_api,career_restore;
GRANT USAGE ON SEQUENCE career.application_display_sequence TO career_api,career_restore;
GRANT EXECUTE ON FUNCTION career.valid_date_value(jsonb),career.next_display_id(),career.configured_owner() TO career_api,career_restore;
GRANT EXECUTE ON FUNCTION career.runtime_owner(uuid),career.runtime_ready() TO career_api;
GRANT EXECUTE ON FUNCTION career.restore_insert_allowed(uuid) TO career_restore;

GRANT SELECT ON career.owner_config,career.maintenance_state TO career_api,career_restore;
CREATE POLICY owner_config_read ON career.owner_config FOR SELECT TO career_api,career_restore USING (singleton);
CREATE POLICY maintenance_read ON career.maintenance_state FOR SELECT TO career_api,career_restore USING (singleton);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['owner_settings','opportunities','applications','contacts','links','resume_refs',
    'application_resumes','evidence','events','tasks','cycles','batches','batch_members','review_versions','import_runs',
    'source_files','import_rows','audit_log','mutation_keys','agent_credentials','creation_requests','opportunity_identities'] LOOP
    EXECUTE format('GRANT SELECT ON career.%I TO career_api',table_name);
    EXECUTE format('CREATE POLICY runtime_select ON career.%I FOR SELECT TO career_api USING (career.runtime_owner(owner_id))',table_name);
    EXECUTE format('CREATE POLICY runtime_maintenance ON career.%I AS RESTRICTIVE FOR ALL TO career_api USING (career.runtime_ready()) WITH CHECK (career.runtime_ready())',table_name);
    IF table_name <> 'audit_log' THEN
      EXECUTE format('GRANT INSERT ON career.%I TO career_api',table_name);
      EXECUTE format('CREATE POLICY runtime_insert ON career.%I FOR INSERT TO career_api WITH CHECK (career.runtime_owner(owner_id))',table_name);
      IF table_name NOT IN ('review_versions','mutation_keys','creation_requests') THEN
        EXECUTE format('GRANT UPDATE ON career.%I TO career_api',table_name);
        EXECUTE format('CREATE POLICY runtime_update ON career.%I FOR UPDATE TO career_api USING (career.runtime_owner(owner_id)) WITH CHECK (career.runtime_owner(owner_id))',table_name);
      END IF;
    END IF;
    IF table_name='agent_credentials' THEN
      GRANT SELECT (id,owner_id,label,prefix,scopes,expires_at,revoked_at,created_at,updated_at,version) ON career.agent_credentials TO career_restore;
    ELSE
      EXECUTE format('GRANT SELECT ON career.%I TO career_restore',table_name);
      -- mutation_keys são efêmeras e não fazem parte do histórico restaurável.
      IF table_name <> 'mutation_keys' THEN
        EXECUTE format('GRANT INSERT ON career.%I TO career_restore',table_name);
        EXECUTE format('CREATE POLICY restore_insert ON career.%I FOR INSERT TO career_restore WITH CHECK (career.restore_insert_allowed(owner_id))',table_name);
      END IF;
    END IF;
    EXECUTE format('CREATE POLICY restore_inspect ON career.%I FOR SELECT TO career_restore USING (true)',table_name);
  END LOOP;
END;
$$;

-- Bookkeeping fica exclusivamente com o script local de restauração.
GRANT SELECT,INSERT ON career.restore_runs,career.restore_row_ledger TO career_restore;
GRANT UPDATE (state,restored_rows,verified_at,failure_text,version,updated_at) ON career.restore_runs TO career_restore;
GRANT UPDATE (verified_at,version,updated_at) ON career.restore_row_ledger TO career_restore;
GRANT UPDATE (state,active_restore_run_id,manifest_hash,version,updated_at) ON career.maintenance_state TO career_restore;
CREATE POLICY restore_runs_read ON career.restore_runs FOR SELECT TO career_restore USING (owner_id=career.configured_owner());
CREATE POLICY restore_runs_insert ON career.restore_runs FOR INSERT TO career_restore WITH CHECK (owner_id=career.configured_owner() AND destination_owner_id=career.configured_owner());
CREATE POLICY restore_runs_update ON career.restore_runs FOR UPDATE TO career_restore USING (owner_id=career.configured_owner()) WITH CHECK (owner_id=career.configured_owner() AND destination_owner_id=career.configured_owner());
CREATE POLICY maintenance_restore_update ON career.maintenance_state FOR UPDATE TO career_restore USING (owner_id=career.configured_owner()) WITH CHECK (owner_id=career.configured_owner());
CREATE POLICY restore_ledger_read ON career.restore_row_ledger FOR SELECT TO career_restore USING (owner_id=career.configured_owner());
CREATE POLICY restore_ledger_insert ON career.restore_row_ledger FOR INSERT TO career_restore WITH CHECK (career.restore_insert_allowed(owner_id) AND restore_run_id::text=nullif(current_setting('app.restore_run_id',true),''));
CREATE POLICY restore_ledger_update ON career.restore_row_ledger FOR UPDATE TO career_restore USING (career.restore_insert_allowed(owner_id) AND restore_run_id::text=nullif(current_setting('app.restore_run_id',true),'')) WITH CHECK (career.restore_insert_allowed(owner_id) AND restore_run_id::text=nullif(current_setting('app.restore_run_id',true),''));

-- career_audit_writer recebe somente o papel vazio nesta etapa.
-- A migration de auditoria concederá INSERT mínimo e sua policy junto ao trigger.
