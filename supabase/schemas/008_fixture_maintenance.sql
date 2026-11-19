-- A instalação exige autoridade independente sobre os objetos e papéis. Nunca
-- promover o instalador, o runtime ou o executor para satisfazer este requisito.
CREATE SCHEMA career_maintenance;
REVOKE ALL ON SCHEMA career_maintenance FROM PUBLIC;

-- O PostgreSQL 17 registra automaticamente o criador não-superusuário com
-- ADMIN, sem SET ou herança. Só o perfil gerenciado conhecido pode conservar
-- essa linha. O executor jamais recebe um papel como membro.
CREATE FUNCTION career_maintenance.executor_stamp() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH executor AS (
    SELECT oid FROM pg_roles WHERE rolname='career_fixture_executor' AND NOT
      (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      AND rolconnlimit=-1 AND rolconfig IS NULL AND rolvaliduntil IS NULL
  ), edges AS (
    SELECT m.* FROM pg_auth_members m,executor e WHERE e.oid IN (m.roleid,m.member,m.grantor)
  ), creator AS (
    SELECT oid FROM pg_roles WHERE rolname='postgres' AND rolcanlogin AND rolinherit AND rolcreaterole AND rolbypassrls AND NOT rolsuper
  ), bootstrap AS (
    SELECT oid FROM pg_roles WHERE oid=10 AND rolname='supabase_admin' AND rolsuper
  ), original AS (
    SELECT m.* FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid,creator c,bootstrap b
    WHERE m.member=c.oid AND m.grantor=b.oid AND m.admin_option AND NOT (m.inherit_option OR m.set_option)
      AND r.rolname IN ('career_api','career_restore','career_audit_writer','career_schema_owner')
  )
  SELECT encode(sha256(convert_to(jsonb_build_array(e.oid,
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.oid) FROM edges m),
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.oid) FROM original m))::text,'UTF8')),'hex')
  FROM executor e WHERE NOT EXISTS (SELECT FROM edges) OR (
    (SELECT count(*) FROM edges)=1 AND (SELECT count(*) FROM original)=4
    AND EXISTS (SELECT FROM edges m,creator c,bootstrap b WHERE m.roleid=e.oid AND m.member=c.oid
      AND m.grantor=b.oid AND m.admin_option AND NOT (m.inherit_option OR m.set_option))
    AND NOT EXISTS (SELECT FROM pg_roles r,creator c,bootstrap b WHERE r.rolname IN
       ('career_api','career_restore','career_audit_writer','career_schema_owner','anon','authenticated','service_role')
       AND (pg_has_role(r.oid,c.oid,'MEMBER') OR pg_has_role(r.oid,b.oid,'MEMBER') OR pg_has_role(r.oid,e.oid,'MEMBER'))));
$$;
REVOKE ALL ON FUNCTION career_maintenance.executor_stamp() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION career_maintenance.executor_stamp() TO career_schema_owner;
DO $$
DECLARE executor oid := to_regrole('career_fixture_executor');
BEGIN
  IF executor IS NULL THEN
    CREATE ROLE career_fixture_executor NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
  ELSIF NOT EXISTS (SELECT FROM pg_auth_members WHERE roleid=executor)
    OR EXISTS (SELECT FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=executor
      AND NOT (d.classid='pg_auth_members'::regclass AND d.objid IN (SELECT oid FROM pg_auth_members WHERE roleid=executor)))
    OR EXISTS (SELECT FROM pg_db_role_setting WHERE setrole=executor)
    OR EXISTS (SELECT FROM pg_shseclabel WHERE classoid='pg_authid'::regclass AND objoid=executor) THEN
    RAISE EXCEPTION 'O executor pré-criado deve estar vazio e ter somente a atribuição automática do criador.';
  END IF;
  IF career_maintenance.executor_stamp() IS NULL THEN
    RAISE EXCEPTION 'Atributos ou associações incompatíveis para o executor técnico.';
  END IF;
END $$;
GRANT USAGE ON SCHEMA career_maintenance TO career_schema_owner,career_fixture_executor,career_api,career_restore;
GRANT SELECT ON SEQUENCE career.application_display_sequence TO career_api;
GRANT USAGE ON SCHEMA career TO career_fixture_executor;

CREATE TABLE career_maintenance.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, run_id uuid NOT NULL,
  operation text NOT NULL DEFAULT 'remove_technical_fixture' CHECK(operation='remove_technical_fixture'),
  package_hash text NOT NULL CHECK(package_hash ~ '^[0-9a-f]{64}$'),
  baseline_hash text NOT NULL CHECK(baseline_hash ~ '^[0-9a-f]{64}$'),
  issued_by name NOT NULL DEFAULT session_user, issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '30 minutes'),
  command_key uuid UNIQUE NOT NULL, application_id uuid NOT NULL, opportunity_id uuid NOT NULL,
  prefix text NOT NULL CHECK(prefix IN ('application_only','revoked_initial','revoked_agent','complete')),
  display_id text NOT NULL CHECK(display_id ~ '^N[0-9]{6,19}$'),
  credential_id uuid, application_client_id uuid NOT NULL, application_mapping_id uuid NOT NULL,
  credential_mapping_id uuid, attempted_keys uuid[] NOT NULL,
  CHECK ((prefix='application_only')=(credential_id IS NULL) AND (credential_id IS NULL)=(credential_mapping_id IS NULL)),
  CHECK(array_ndims(attempted_keys)=1 AND cardinality(attempted_keys) BETWEEN 1 AND 6
    AND array_position(attempted_keys,NULL) IS NULL AND NOT command_key=ANY(attempted_keys))
);
CREATE TABLE career_maintenance.outcomes (
  approval_id uuid PRIMARY KEY REFERENCES career_maintenance.approvals(id), run_id uuid UNIQUE NOT NULL, request_id uuid UNIQUE NOT NULL,
  receipt_id uuid UNIQUE NOT NULL, reply jsonb NOT NULL, display_number bigint UNIQUE NOT NULL,
  retained_history jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Somente digests de identidades aposentadas. Estas linhas apenas impedem reutilização.
CREATE TABLE career_maintenance.retired_identities (
  owner_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('client','key')),
  digest text COLLATE "C" NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'), PRIMARY KEY(owner_id,kind,digest)
);
ALTER TABLE career_maintenance.retired_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_maintenance.retired_identities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA career_maintenance FROM PUBLIC,career_api,career_restore;
GRANT SELECT ON career_maintenance.retired_identities TO career_api,career_restore,career_fixture_executor,career_schema_owner;
GRANT INSERT ON career_maintenance.retired_identities TO career_fixture_executor,career_restore;
CREATE POLICY runtime_read ON career_maintenance.retired_identities FOR SELECT TO career_api
  USING (career.runtime_owner(owner_id) AND career.runtime_ready());
CREATE POLICY restore_read ON career_maintenance.retired_identities FOR SELECT TO career_restore USING (true);
CREATE POLICY restore_insert ON career_maintenance.retired_identities FOR INSERT TO career_restore
  WITH CHECK (career.restore_insert_allowed(owner_id));
CREATE POLICY fixture_read ON career_maintenance.retired_identities FOR SELECT TO career_fixture_executor,career_schema_owner USING (true);
CREATE POLICY fixture_insert ON career_maintenance.retired_identities FOR INSERT TO career_fixture_executor
  WITH CHECK (owner_id::text=current_setting('app.owner_id',true));
GRANT SELECT ON career_maintenance.approvals,career_maintenance.outcomes TO career_fixture_executor;
GRANT INSERT ON career_maintenance.outcomes TO career_fixture_executor;
GRANT SELECT(display_number,retained_history) ON career_maintenance.outcomes TO career_schema_owner;
CREATE FUNCTION career_maintenance.preserve_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Evidência administrativa imutável.' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION career_maintenance.preserve_evidence() FROM PUBLIC;
CREATE TRIGGER immutable_approval BEFORE UPDATE OR DELETE OR TRUNCATE ON career_maintenance.approvals
  FOR EACH STATEMENT EXECUTE FUNCTION career_maintenance.preserve_evidence();
CREATE TRIGGER immutable_retirement BEFORE UPDATE OR DELETE OR TRUNCATE ON career_maintenance.retired_identities
  FOR EACH STATEMENT EXECUTE FUNCTION career_maintenance.preserve_evidence();
CREATE TRIGGER immutable_outcome BEFORE UPDATE OR DELETE OR TRUNCATE ON career_maintenance.outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION career_maintenance.preserve_evidence();

-- O dono das tabelas também está sujeito a FORCE. A policy de leitura permite
-- ao auxiliar privado inspecionar inclusive registros de outro proprietário.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_credentials','application_resumes','applications','audit_log','batch_members','batches',
    'contacts','creation_requests','cycles','events','evidence','import_rows','import_runs','links','maintenance_state',
    'mutation_keys','opportunities','opportunity_identities','owner_config','owner_settings','restore_row_ledger',
    'restore_runs','resume_refs','review_versions','source_files','tasks'] LOOP
    EXECUTE format('CREATE POLICY fixture_inventory ON career.%I FOR SELECT TO career_schema_owner USING (true)',t);
  END LOOP;
END $$;

-- Identidade física e definições que influenciam a operação. Exclui estatísticas
-- voláteis, valores de credenciais e objetos internos de outras aplicações.
CREATE FUNCTION career_maintenance.catalog_hash() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH spaces AS (
    SELECT oid,nspname,nspowner,nspacl FROM pg_namespace WHERE nspname IN ('career','career_maintenance')
  ), rels AS (
    SELECT oid,relname,relkind,relowner,relacl,relrowsecurity,relforcerowsecurity,relnamespace,
           relpersistence,relispartition,reloptions,relreplident
      FROM pg_class WHERE relnamespace IN (SELECT oid FROM spaces)
  ), principals AS (
    SELECT oid FROM pg_roles WHERE rolname IN ('career_api','career_restore','career_audit_writer','career_schema_owner','career_fixture_executor')
  ), memberships AS (
    SELECT * FROM pg_auth_members WHERE member IN (SELECT oid FROM principals) OR roleid IN (SELECT oid FROM principals)
  ), roles AS (
    SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,
           rolconnlimit,rolvaliduntil,rolbypassrls,rolconfig FROM pg_roles WHERE oid IN (
      SELECT oid FROM principals UNION SELECT nspowner FROM spaces UNION SELECT grantor FROM memberships
      UNION SELECT member FROM memberships UNION SELECT roleid FROM memberships)
  ), parts(kind, item) AS (
    SELECT 'database',to_jsonb(oid) FROM pg_database WHERE datname=current_database()
    UNION ALL SELECT 'namespace',to_jsonb(s) FROM spaces s
    UNION ALL SELECT 'role',to_jsonb(r) FROM roles r
    UNION ALL SELECT 'role_default',to_jsonb(d) FROM pg_db_role_setting d
      WHERE (d.setdatabase=0 OR d.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()))
        AND (d.setrole=0 OR d.setrole IN (SELECT oid FROM roles))
    UNION ALL SELECT 'membership',to_jsonb(m) FROM memberships m
    UNION ALL SELECT 'relation',to_jsonb(r) FROM rels r
    UNION ALL SELECT 'column',to_jsonb(a) FROM pg_attribute a WHERE a.attrelid IN (SELECT oid FROM rels) AND a.attnum>0
    UNION ALL SELECT 'default',to_jsonb(d) FROM pg_attrdef d WHERE d.adrelid IN (SELECT oid FROM rels)
    UNION ALL SELECT 'policy',to_jsonb(p) FROM pg_policy p WHERE p.polrelid IN (SELECT oid FROM rels)
    UNION ALL SELECT 'trigger',to_jsonb(t) FROM pg_trigger t WHERE t.tgrelid IN (SELECT oid FROM rels)
    UNION ALL SELECT 'rule',to_jsonb(r) FROM pg_rewrite r WHERE r.ev_class IN (SELECT oid FROM rels)
    UNION ALL SELECT 'inheritance',to_jsonb(i) FROM pg_inherits i
      WHERE i.inhrelid IN (SELECT oid FROM rels) OR i.inhparent IN (SELECT oid FROM rels)
    UNION ALL SELECT 'constraint',to_jsonb(c) FROM pg_constraint c WHERE c.connamespace IN (SELECT oid FROM spaces)
      OR c.confrelid IN (SELECT oid FROM rels)
    UNION ALL SELECT 'index',to_jsonb(i) FROM pg_index i WHERE i.indrelid IN (SELECT oid FROM rels)
    UNION ALL SELECT 'type',to_jsonb(t) FROM pg_type t WHERE t.typnamespace IN (SELECT oid FROM spaces)
    UNION ALL SELECT 'function',to_jsonb(p) FROM pg_proc p WHERE p.pronamespace IN (SELECT oid FROM spaces)
    UNION ALL SELECT 'sequence',to_jsonb(s) FROM pg_sequence s WHERE s.seqrelid IN (SELECT oid FROM rels)
  )
  SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(kind,item) ORDER BY kind COLLATE "C",item)::text,'UTF8')),'hex') FROM parts;
$$;
REVOKE ALL ON FUNCTION career_maintenance.catalog_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION career_maintenance.catalog_hash() TO career_schema_owner;

-- Assina a configuração e o histórico retido. Ao abrir uma execução, exclui
-- somente os três IDs da verificação atual. Ao fechá-la, inclui tudo.
CREATE FUNCTION career_maintenance.history(excluded uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO, YMD' AS $$
  WITH items(kind,body) AS (
    SELECT 'owner_config',to_jsonb(t) FROM ONLY career.owner_config t
    UNION ALL SELECT 'maintenance_state',to_jsonb(t) FROM ONLY career.maintenance_state t
    UNION ALL SELECT 'owner_settings',to_jsonb(t) FROM ONLY career.owner_settings t
    UNION ALL SELECT 'audit',to_jsonb(t) FROM ONLY career.audit_log t WHERE NOT (t.entity_id=ANY(excluded))
    UNION ALL SELECT 'reply',to_jsonb(t) FROM ONLY career.mutation_keys t WHERE NOT (
      (t.operation='application_command' AND coalesce(t.safe_response#>>'{application,id}','')=ANY(excluded::text[]))
      OR (t.operation='credential_command' AND coalesce(t.safe_response#>>'{credential,id}','')=ANY(excluded::text[])))
  ), digests AS (SELECT kind,encode(sha256(convert_to(body::text,'UTF8')),'hex') AS h FROM items)
  SELECT jsonb_build_object('audits',count(*) FILTER (WHERE kind='audit'),'replies',count(*) FILTER (WHERE kind='reply'),
    'digest',encode(sha256(convert_to(string_agg(kind||h,'' ORDER BY kind COLLATE "C",h COLLATE "C"),'UTF8')),'hex')) FROM digests;
$$;
ALTER FUNCTION career_maintenance.history(uuid[]) OWNER TO career_schema_owner;
REVOKE ALL ON FUNCTION career_maintenance.history(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION career_maintenance.history(uuid[]) TO career_fixture_executor;

CREATE FUNCTION career_maintenance.baseline(run_id uuid, expected_prefix text DEFAULT 'complete') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO, YMD' AS $$
DECLARE t text; n integer; hashes jsonb; inventory jsonb := '{}'::jsonb;
  names constant text[] := ARRAY['agent_credentials','application_resumes','applications','audit_log','batch_members','batches',
    'contacts','creation_requests','cycles','events','evidence','import_rows','import_runs','links','maintenance_state',
    'mutation_keys','opportunities','opportunity_identities','owner_config','owner_settings','restore_row_ledger',
    'restore_runs','resume_refs','review_versions','source_files','tasks'];
  counts jsonb := '{"applications":1,"maintenance_state":1,"opportunities":1,"owner_config":1,"owner_settings":1}';
  a uuid; o uuid; c uuid; owner uuid; v integer; display text; seq bigint; prior_display bigint; prior jsonb; retained jsonb;
  bound integer; business_audits integer; business_replies integer;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
     AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
     AND classid=1128354386 AND objid=1 AND objsubid=2 AND mode='ExclusiveLock') THEN
    RAISE EXCEPTION 'Admissão exclusiva necessária.' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('career_api','career_schema_owner','career_fixture_executor')
        AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit))
     OR EXISTS (SELECT FROM pg_roles WHERE rolname IN ('career_schema_owner','career_fixture_executor') AND rolcanlogin)
     OR career_maintenance.executor_stamp() IS NULL OR career_maintenance.executor_stamp()
        IS DISTINCT FROM current_setting('career_maintenance.executor_stamp',true)
  THEN RAISE EXCEPTION 'Autoridade técnica incompatível.' USING ERRCODE='P0412'; END IF;
  FOREACH t IN ARRAY names LOOP
    EXECUTE format('LOCK TABLE ONLY career.%I IN EXCLUSIVE MODE NOWAIT',t);
  END LOOP;
  IF (SELECT array_agg(relname::text ORDER BY relname COLLATE "C") FROM pg_class WHERE relnamespace='career'::regnamespace
        AND relkind IN ('r','p')) IS DISTINCT FROM names OR EXISTS (SELECT FROM pg_class WHERE relnamespace='career'::regnamespace
        AND relkind='r' AND NOT (relrowsecurity AND relforcerowsecurity AND relowner='career_schema_owner'::regrole))
     OR EXISTS (SELECT FROM pg_inherits i JOIN pg_class c ON c.oid IN (i.inhparent,i.inhrelid)
        WHERE c.relnamespace='career'::regnamespace AND c.relkind IN ('r','p')) THEN
    RAISE EXCEPTION 'Catálogo incompatível.' USING ERRCODE='P0412';
  END IF;
  SELECT id,opportunity_id,owner_id,version,display_id INTO a,o,owner,v,display FROM ONLY career.applications LIMIT 1;
  SELECT id INTO c FROM ONLY career.agent_credentials LIMIT 1;
  SELECT last_value INTO seq FROM career.application_display_sequence WHERE is_called;
  SELECT display_number,retained_history INTO prior_display,prior FROM career_maintenance.outcomes ORDER BY display_number DESC LIMIT 1;
  IF a IS NULL OR v NOT IN (1,2,3) OR c IS NULL AND v<>1 OR seq IS NULL
    OR expected_prefix IS DISTINCT FROM (CASE WHEN c IS NULL THEN 'application_only' WHEN v=1 THEN 'revoked_initial'
       WHEN v=2 THEN 'revoked_agent' WHEN v=3 THEN 'complete' END)
    OR display !~ '^N[0-9]{6,19}$' OR substring(display FROM 2)::numeric>seq
    OR substring(display FROM 2)::numeric<=coalesce(prior_display,0) THEN
    RAISE EXCEPTION 'Prefixo ou sequência incompatível.' USING ERRCODE='P0412';
  END IF;
  business_audits := v+1+CASE WHEN c IS NULL THEN 0 ELSE 2 END;
  business_replies := business_audits-1;
  counts := counts || jsonb_build_object('agent_credentials',CASE WHEN c IS NULL THEN 0 ELSE 1 END,
    'creation_requests',CASE WHEN c IS NULL THEN 1 ELSE 2 END,'audit_log',coalesce((prior->>'audits')::int,1)+business_audits,
    'mutation_keys',coalesce((prior->>'replies')::int,0)+business_replies);
  FOREACH t IN ARRAY names LOOP
    bound := coalesce((counts->>t)::int,0);
    -- Uma linha extra basta para recusar antes de construir um inventário maior.
    EXECUTE format('SELECT count(*),coalesce(jsonb_agg(h ORDER BY h),''[]''::jsonb) FROM
      (SELECT encode(sha256(convert_to($1::text || ''/'' || to_jsonb(row_data)::text,''UTF8'')),''hex'') h
         FROM (SELECT * FROM ONLY career.%I LIMIT $2) row_data) grouped',t) INTO n,hashes USING run_id,bound+1;
    IF n <> bound THEN
      RAISE EXCEPTION 'Inventário incompatível.' USING ERRCODE='P0412';
    END IF;
    inventory := inventory || jsonb_build_object(t,hashes);
  END LOOP;
  -- Cada transição prevista exige sua imagem, ator e origem reais.
  IF EXISTS (
    WITH expected(include,kind,id,actor,actor_id,source,op,old_v,new_v,note) AS (VALUES
      (true,'opportunities',o,'owner',owner,'web','insert',NULL::text,'1',NULL::text),
      (true,'applications',a,'owner',owner,'web','insert',NULL,'1','Fictional Task 23 initial '||run_id),
      (v>=2,'applications',a,'agent',c,'agent','update','1','2','Fictional Task 23 agent '||run_id),
      (v=3,'applications',a,'owner',owner,'web','update','2','3','Fictional Task 23 owner '||run_id),
      (c IS NOT NULL,'agent_credentials',c,'owner',owner,'web','insert',NULL,'1',NULL),
      (c IS NOT NULL,'agent_credentials',c,'owner',owner,'web','update','1','2',NULL))
    SELECT kind,id,actor,actor_id::text,source,op,old_v,new_v,note FROM expected WHERE include
    EXCEPT ALL SELECT h.entity_type,h.entity_id,h.actor_kind,h.actor_id,h.source,h.operation,
      h.before_data->>'version',h.after_data->>'version',
      CASE WHEN h.entity_type='applications' THEN h.after_data->>'notes' END
      FROM ONLY career.audit_log h WHERE h.owner_id=owner AND h.entity_id=ANY(array_remove(ARRAY[a,o,c],NULL))
  ) OR (SELECT count(DISTINCT request_id) FROM ONLY career.audit_log h
      WHERE h.entity_id=ANY(array_remove(ARRAY[a,o,c],NULL)))<>business_replies
    OR (SELECT count(DISTINCT request_id) FROM ONLY career.audit_log h
      WHERE h.entity_id IN (a,o) AND h.operation='insert')<>1 THEN
    RAISE EXCEPTION 'Histórico do prefixo incompatível.' USING ERRCODE='P0412';
  END IF;
  retained := career_maintenance.history(array_remove(ARRAY[a,o,c],NULL));
  IF prior IS NOT NULL AND retained IS DISTINCT FROM prior OR prior IS NULL AND (
    (retained->>'audits')::int<>1 OR (retained->>'replies')::int<>0 OR NOT EXISTS (
      SELECT FROM ONLY career.audit_log h JOIN ONLY career.owner_settings s ON h.entity_id=s.id AND h.owner_id=s.owner_id
      WHERE h.actor_kind='owner' AND h.actor_id=s.owner_id::text AND h.source='provisioning' AND h.entity_type='owner_settings'
        AND h.operation='insert' AND h.before_data IS NULL AND h.after_data=to_jsonb(s))) THEN
    RAISE EXCEPTION 'Histórico anterior divergente.' USING ERRCODE='P0412';
  END IF;
  RETURN encode(sha256(convert_to(jsonb_build_array(run_id,inventory,career_maintenance.catalog_hash(),seq,true,prior,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY owner_id,kind COLLATE "C",digest) FROM career_maintenance.retired_identities r))::text,'UTF8')),'hex');
END $$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION career_maintenance.baseline(uuid,text) SET career_maintenance.executor_stamp TO %L',
    career_maintenance.executor_stamp());
END $$;
ALTER FUNCTION career_maintenance.baseline(uuid,text) OWNER TO career_schema_owner;
REVOKE ALL ON FUNCTION career_maintenance.baseline(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION career_maintenance.baseline(uuid,text) TO career_fixture_executor;

-- O executor lê e remove exclusivamente os IDs da autorização em curso.
CREATE FUNCTION career_maintenance.allowed_target(target_table text, target_owner uuid, target_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
  SELECT session_user='career_api' AND current_setting('app.actor_kind',true)='owner'
     AND current_setting('app.source',true)='maintenance' AND current_setting('app.actor_id',true)=target_owner::text
     AND EXISTS (SELECT FROM career_maintenance.approvals a WHERE a.id::text=current_setting('app.fixture_approval',true)
     AND a.owner_id=target_owner AND target_owner::text=current_setting('app.owner_id',true)
     AND a.issued_at<=clock_timestamp() AND a.expires_at>clock_timestamp()
     AND NOT EXISTS (SELECT FROM career_maintenance.outcomes o WHERE o.run_id=a.run_id)
     AND CASE target_table WHEN 'creation_requests' THEN target_id IN (a.application_mapping_id,a.credential_mapping_id)
       WHEN 'applications' THEN target_id=a.application_id WHEN 'opportunities' THEN target_id=a.opportunity_id
       WHEN 'agent_credentials' THEN target_id=a.credential_id ELSE false END);
$$;
REVOKE ALL ON FUNCTION career_maintenance.allowed_target(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION career_maintenance.allowed_target(text,uuid,uuid) TO career_fixture_executor;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['applications','opportunities','creation_requests','agent_credentials'] LOOP
    EXECUTE format('GRANT DELETE ON career.%I TO career_fixture_executor',t);
    EXECUTE format('CREATE POLICY fixture_target ON career.%I FOR ALL TO career_fixture_executor
       USING (career_maintenance.allowed_target(%L,owner_id,id)) WITH CHECK(false)',t,t);
  END LOOP;
END $$;
GRANT SELECT ON career.applications,career.opportunities,career.creation_requests TO career_fixture_executor;
GRANT SELECT (id,owner_id,label,prefix,scopes,expires_at,revoked_at,version) ON career.agent_credentials TO career_fixture_executor;
GRANT SELECT,INSERT ON career.mutation_keys TO career_fixture_executor;
CREATE POLICY fixture_receipt_read ON career.mutation_keys FOR SELECT TO career_fixture_executor USING
  (owner_id::text=current_setting('app.owner_id',true));
CREATE POLICY fixture_receipt_add ON career.mutation_keys FOR INSERT TO career_fixture_executor WITH CHECK
  (owner_id::text=current_setting('app.owner_id',true) AND actor_kind='owner' AND actor_id=owner_id::text
   AND operation='remove_technical_fixture' AND http_status=200);
GRANT SELECT ON career.audit_log TO career_fixture_executor;
CREATE POLICY fixture_audit_read ON career.audit_log FOR SELECT TO career_fixture_executor USING
  (owner_id::text=current_setting('app.owner_id',true) AND request_id::text=current_setting('app.request_id',true));

CREATE FUNCTION career_maintenance.remove_fixture(approval uuid, run uuid, package text, key uuid, payload_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE a career_maintenance.approvals%ROWTYPE; previous career.mutation_keys%ROWTYPE;
  outcome career_maintenance.outcomes%ROWTYPE; request uuid; result jsonb; receipt uuid := gen_random_uuid();
  app_map uuid; cred_map uuid; app uuid; opp uuid; cred uuid; app_version integer; steps text[]; observed_steps text[];
  unknown_date constant jsonb := '{"precision":"unknown","value":null}';
BEGIN
  IF session_user<>'career_api' OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'owner'
    OR current_setting('app.source',true) IS DISTINCT FROM 'maintenance'
    OR current_setting('app.owner_id',true) IS DISTINCT FROM current_setting('app.actor_id',true)
    OR current_setting('transaction_isolation')<>'read committed'
    OR NOT EXISTS (SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND locktype='advisory'
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=1128354386 AND objid=1 AND objsubid=2 AND mode='ExclusiveLock') THEN
    RAISE EXCEPTION 'Contexto inválido.' USING ERRCODE='42501';
  END IF;
  request := nullif(current_setting('app.request_id',true),'')::uuid;
  IF request IS NULL THEN RAISE EXCEPTION 'Requisição ausente.' USING ERRCODE='42501'; END IF;
  SELECT * INTO previous FROM career.mutation_keys WHERE owner_id::text=current_setting('app.owner_id')
    AND actor_kind='owner' AND actor_id=current_setting('app.owner_id') AND operation='remove_technical_fixture' AND idempotency_key=key::text;
  IF FOUND THEN
    SELECT * INTO outcome FROM career_maintenance.outcomes WHERE approval_id=approval AND receipt_id=previous.id;
    IF NOT FOUND OR previous.http_status<>200 OR previous.request_hash IS DISTINCT FROM payload_hash
      OR previous.safe_response IS DISTINCT FROM outcome.reply OR NOT EXISTS (SELECT FROM career_maintenance.approvals
        WHERE id=approval AND command_key=key AND run_id=run AND package_hash=package) THEN
      RAISE EXCEPTION 'Chave reutilizada.' USING ERRCODE='P0409';
    END IF;
    RETURN outcome.reply;
  END IF;
  -- Bloqueia alteração/revogação administrativa desta autorização até o COMMIT.
  -- A tabela permanece somente leitura para o executor. SHARE conflita com DML.
  PERFORM career_maintenance.lock_approval();
  SELECT * INTO a FROM career_maintenance.approvals WHERE id=approval AND run_id=run AND package_hash=package
    AND command_key=key AND owner_id::text=current_setting('app.owner_id') AND issued_at<=clock_timestamp()
    AND expires_at>clock_timestamp() AND NOT EXISTS (SELECT FROM career_maintenance.outcomes WHERE run_id=run);
  IF NOT FOUND THEN RAISE EXCEPTION 'Autorização indisponível.' USING ERRCODE='42501'; END IF;
  IF career_maintenance.baseline(run,a.prefix) IS DISTINCT FROM a.baseline_hash THEN
    RAISE EXCEPTION 'A origem divergiu da autorização.' USING ERRCODE='P0412';
  END IF;
  PERFORM set_config('app.fixture_approval',approval::text,true);
  app_version := CASE a.prefix WHEN 'complete' THEN 3 WHEN 'revoked_agent' THEN 2 ELSE 1 END;
  steps := CASE a.prefix WHEN 'application_only' THEN ARRAY['create']
    WHEN 'revoked_initial' THEN ARRAY['create','mint','revoke'] WHEN 'revoked_agent' THEN ARRAY['agent','create','mint','revoke']
    WHEN 'complete' THEN ARRAY['agent','create','mint','repair','revoke'] END;
  SELECT array_agg(step ORDER BY step COLLATE "C") INTO observed_steps FROM (
    SELECT CASE
      WHEN operation='application_command' AND safe_response#>>'{application,id}'=a.application_id::text THEN CASE
        WHEN actor_kind='owner' AND actor_id=a.owner_id::text AND http_status=201 AND safe_response#>>'{application,version}'='1' THEN 'create'
        WHEN actor_kind='agent' AND actor_id=a.credential_id::text AND http_status=200 AND safe_response#>>'{application,version}'='2' THEN 'agent'
        WHEN actor_kind='owner' AND actor_id=a.owner_id::text AND http_status=200 AND safe_response#>>'{application,version}'='3' THEN 'repair' END
      WHEN operation='credential_command' AND actor_kind='owner' AND actor_id=a.owner_id::text AND safe_response#>>'{credential,id}'=a.credential_id::text THEN CASE
        WHEN http_status=201 AND safe_response#>>'{credential,version}'='1' THEN 'mint'
        WHEN http_status=200 AND safe_response#>>'{credential,version}'='2' THEN 'revoke' END END AS step
    FROM career.mutation_keys WHERE idempotency_key=ANY(a.attempted_keys::text[])
  ) accepted;
  IF observed_steps IS DISTINCT FROM steps OR (SELECT count(DISTINCT value) FROM unnest(a.attempted_keys) value)<>cardinality(a.attempted_keys)
    OR cardinality(a.attempted_keys) NOT BETWEEN cardinality(steps) AND cardinality(steps)+1
    OR a.prefix='complete' AND cardinality(a.attempted_keys)<>6
    OR EXISTS (SELECT FROM unnest(a.attempted_keys || a.command_key) proposed(id)
      JOIN career_maintenance.retired_identities old ON old.owner_id=a.owner_id AND old.kind='key'
        AND old.digest=encode(sha256(convert_to(proposed.id::text,'UTF8')),'hex'))
    OR NOT EXISTS (SELECT FROM career.applications WHERE id=a.application_id AND opportunity_id=a.opportunity_id
      AND display_id=a.display_id AND submission_status='nao_enviado' AND submitted_date=unknown_date AND stage='desconhecida'
      AND version=app_version AND notes='Fictional Task 23 '||(ARRAY['initial','agent','owner'])[app_version]||' '||run::text
      AND legacy_id IS NULL AND track IS NULL
      AND application_instance='initial' AND cycle_relation='unknown' AND cycle_order IS NULL AND counting_eligible
      AND archived_at IS NULL AND canonical_application_id IS NULL AND legacy_registered_date=unknown_date
      AND legacy_resume_text IS NULL AND discovery_channel IS NULL AND submission_platform IS NULL)
    OR NOT EXISTS (SELECT FROM career.opportunities WHERE id=a.opportunity_id AND version=1
      AND company='Task 23 Fictional Company '||run::text AND title='Task 23 Fictional Role '||run::text
      AND kind='vaga' AND num_nonnulls(platform,tenant,job_code,job_key,seniority,modality,description)=0 AND cardinality(stack)=0)
    OR a.credential_id IS NOT NULL AND NOT EXISTS (SELECT id FROM career.agent_credentials WHERE id=a.credential_id AND version=2 AND revoked_at IS NOT NULL
      AND label='Task 23 Fictional Agent '||run::text AND isfinite(expires_at) AND prefix=left(id::text,8)
      AND scopes=ARRAY['career:read','career:write']) THEN
    RAISE EXCEPTION 'Dados técnicos incompatíveis.' USING ERRCODE='P0412';
  END IF;
  DELETE FROM ONLY career.creation_requests WHERE id=a.application_mapping_id AND entity_type='application'
    AND client_id=a.application_client_id AND result_application_id=a.application_id RETURNING id INTO app_map;
  IF a.credential_id IS NOT NULL THEN
    DELETE FROM ONLY career.creation_requests WHERE id=a.credential_mapping_id AND entity_type='agent_credential'
      AND client_id=a.credential_id AND result_credential_id=a.credential_id RETURNING id INTO cred_map;
  END IF;
  IF ARRAY[app_map,cred_map] IS DISTINCT FROM ARRAY[a.application_mapping_id,a.credential_mapping_id] THEN
    RAISE EXCEPTION 'Mapeamentos técnicos divergentes.' USING ERRCODE='P0412';
  END IF;
  DELETE FROM ONLY career.applications WHERE id=a.application_id RETURNING id INTO app;
  DELETE FROM ONLY career.opportunities WHERE id=a.opportunity_id RETURNING id INTO opp;
  IF a.credential_id IS NOT NULL THEN
    DELETE FROM ONLY career.agent_credentials WHERE id=a.credential_id AND revoked_at IS NOT NULL RETURNING id INTO cred;
  END IF;
  IF ARRAY[app_map,cred_map,app,opp,cred] IS DISTINCT FROM
     ARRAY[a.application_mapping_id,a.credential_mapping_id,a.application_id,a.opportunity_id,a.credential_id]
     OR (SELECT count(*) FROM career.audit_log WHERE actor_kind='owner' AND actor_id=a.owner_id::text
       AND source='maintenance' AND request_id=request AND operation='delete' AND after_data IS NULL
       AND (entity_type,entity_id) IN (('applications',app),('opportunities',opp),('agent_credentials',cred)))
       <>(CASE WHEN cred IS NULL THEN 2 ELSE 3 END) THEN
    RAISE EXCEPTION 'Resultado técnico divergente.' USING ERRCODE='P0412';
  END IF;
  result := jsonb_strip_nulls(jsonb_build_object('runId',run,'requestId',request,'applicationId',app,'opportunityId',opp,
    'credentialId',cred,'applicationMappingId',app_map,'credentialMappingId',cred_map));
  INSERT INTO career.mutation_keys(id,owner_id,actor_kind,actor_id,operation,idempotency_key,request_hash,http_status,safe_response)
    VALUES(receipt,a.owner_id,'owner',a.owner_id::text,'remove_technical_fixture',key::text,payload_hash,200,result);
  INSERT INTO career_maintenance.outcomes(approval_id,run_id,request_id,receipt_id,reply,display_number,retained_history)
    SELECT approval,run,request,receipt,result,substring(a.display_id FROM 2)::bigint,career_maintenance.history('{}'::uuid[])
      WHERE clock_timestamp()<a.expires_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'Autorização expirada.' USING ERRCODE='42501'; END IF;
  INSERT INTO career_maintenance.retired_identities(owner_id,kind,digest)
    SELECT a.owner_id,kind,encode(sha256(convert_to(id::text,'UTF8')),'hex') FROM (
      SELECT 'client' AS kind,unnest(ARRAY[a.application_client_id,a.credential_id]) AS id
      UNION ALL SELECT 'key',unnest(a.attempted_keys || a.command_key)
    ) retired WHERE id IS NOT NULL;
  IF clock_timestamp()>=a.expires_at THEN RAISE EXCEPTION 'Autorização expirada.' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION career_maintenance.remove_fixture(uuid,uuid,text,uuid,text) OWNER TO career_fixture_executor;
REVOKE ALL ON FUNCTION career_maintenance.remove_fixture(uuid,uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION career_maintenance.remove_fixture(uuid,uuid,text,uuid,text) TO career_api;

CREATE FUNCTION career_maintenance.lock_approval() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  LOCK TABLE career_maintenance.approvals IN SHARE MODE NOWAIT;
END $$;
REVOKE ALL ON FUNCTION career_maintenance.lock_approval() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION career_maintenance.lock_approval() TO career_fixture_executor;

-- AFTER INSERT mantém o replay idêntico de uma resposta já gravada. Uma
-- identidade aposentada nunca cria novamente negócio ou uma nova resposta.
CREATE FUNCTION career_maintenance.refuse_retired_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='creation_requests' THEN
    IF EXISTS (SELECT FROM career_maintenance.retired_identities WHERE owner_id=NEW.owner_id AND kind='client'
      AND digest=encode(sha256(convert_to(NEW.client_id::text,'UTF8')),'hex')) THEN
      RAISE EXCEPTION 'Identidade técnica aposentada.' USING ERRCODE='P0409';
    END IF;
  ELSIF EXISTS (SELECT FROM career_maintenance.retired_identities WHERE owner_id=NEW.owner_id AND kind='key'
      AND digest=encode(sha256(convert_to(lower(NEW.idempotency_key),'UTF8')),'hex')) THEN
    RAISE EXCEPTION 'Chave técnica aposentada.' USING ERRCODE='P0409';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION career_maintenance.refuse_retired_identity() OWNER TO career_fixture_executor;
REVOKE ALL ON FUNCTION career_maintenance.refuse_retired_identity() FROM PUBLIC;
CREATE TRIGGER fixture_retired_client AFTER INSERT ON career.creation_requests
  FOR EACH ROW EXECUTE FUNCTION career_maintenance.refuse_retired_identity();
CREATE TRIGGER fixture_retired_key AFTER INSERT ON career.mutation_keys
  FOR EACH ROW EXECUTE FUNCTION career_maintenance.refuse_retired_identity();

-- Privilégios padrão definidos fora do projeto podem conceder acesso adicional
-- durante CREATE. Interromper a instalação inteira se o esquema privado os herdar.
DO $$ BEGIN
  IF EXISTS (
    SELECT FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) x
    WHERE n.oid='career_maintenance'::regnamespace AND x.grantee<>n.nspowner
      AND (x.is_grantable OR x.privilege_type<>'USAGE' OR x.grantee NOT IN
        ('career_api'::regrole,'career_fixture_executor'::regrole,'career_schema_owner'::regrole,'career_restore'::regrole))
  ) OR EXISTS (
    SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.relnamespace='career_maintenance'::regnamespace
      AND x.grantee<>c.relowner AND (x.is_grantable OR NOT (
        x.grantee='career_fixture_executor'::regrole AND (x.privilege_type='SELECT'
          OR c.relname IN ('outcomes','retired_identities') AND x.privilege_type='INSERT')
        OR c.relname='retired_identities' AND (x.grantee IN ('career_api'::regrole,'career_schema_owner'::regrole) AND x.privilege_type='SELECT'
          OR x.grantee='career_restore'::regrole AND x.privilege_type IN ('SELECT','INSERT'))))
  ) OR EXISTS (
    SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x WHERE p.pronamespace='career_maintenance'::regnamespace
      AND x.grantee<>p.proowner AND (x.is_grantable OR x.privilege_type<>'EXECUTE' OR NOT (
        p.proname='remove_fixture' AND x.grantee='career_api'::regrole
        OR p.proname IN ('catalog_hash','executor_stamp') AND x.grantee='career_schema_owner'::regrole
        OR p.proname IN ('allowed_target','lock_approval','baseline','history') AND x.grantee='career_fixture_executor'::regrole))
  ) THEN RAISE EXCEPTION 'Privilégios adicionais no esquema administrativo.'; END IF;
END $$;
