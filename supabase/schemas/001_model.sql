-- Modelo privado; privilégios/RLS e contexto de auditoria são definidos nas próximas etapas.
CREATE SCHEMA career;
REVOKE ALL ON SCHEMA career FROM PUBLIC;

CREATE FUNCTION career.valid_date_value(input jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE
  precision text := input->>'precision';
  value text := input->>'value';
  day_text text;
BEGIN
  IF jsonb_typeof(input) <> 'object' THEN RETURN false; END IF;
  IF precision = 'unknown' THEN
    RETURN input = '{"precision":"unknown","value":null}'::jsonb;
  END IF;
  IF precision NOT IN ('day','month','year','instant') OR precision IS NULL
     OR input->>'certainty' NOT IN ('exact','approximate') OR input->>'certainty' IS NULL
     OR jsonb_typeof(input->'value') <> 'string' OR value IS NULL
     OR input <> jsonb_build_object('precision',precision,'certainty',input->>'certainty','value',value)
  THEN RETURN false; END IF;
  IF precision = 'year' THEN
    RETURN value ~ '^[0-9]{4}$' AND value <> '0000';
  ELSIF precision = 'month' THEN
    RETURN value ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND left(value,4) <> '0000';
  ELSIF precision = 'day' THEN
    IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
    day_text := value;
  ELSE
    IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    THEN RETURN false; END IF;
    day_text := left(value,10);
  END IF;
  RETURN to_char(day_text::date,'YYYY-MM-DD') = day_text;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$$;
CREATE DOMAIN career.date_value AS jsonb CHECK (VALUE IS NULL OR career.valid_date_value(VALUE) IS TRUE);
CREATE DOMAIN career.positive_version AS integer CHECK (VALUE > 0);
CREATE DOMAIN career.sha256 AS text CHECK (VALUE ~ '^[a-f0-9]{64}$');
CREATE SEQUENCE career.application_display_sequence AS bigint MINVALUE 1 NO CYCLE;
CREATE FUNCTION career.next_display_id() RETURNS text
LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT 'N' || lpad(value::text, greatest(6,length(value::text)), '0')
  FROM nextval('career.application_display_sequence') AS value;
$$;

CREATE TABLE career.owner_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_id uuid NOT NULL UNIQUE,
  provisioned_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE career.owner_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL UNIQUE,
  daily_goal integer NOT NULL DEFAULT 5 CHECK (daily_goal > 0),
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo' CHECK (timezone = 'America/Sao_Paulo'),
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id)
);
CREATE TABLE career.opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  company text, title text, platform text, tenant text, job_code text, job_key text,
  kind text NOT NULL DEFAULT 'desconhecido' CHECK (kind IN ('vaga','banco_talentos','pipeline','desconhecido')),
  seniority text, modality text, description text, stack text[] NOT NULL DEFAULT '{}',
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id)
);
CREATE TABLE career.applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  legacy_id text, display_id text NOT NULL DEFAULT career.next_display_id(),
  track text,
  normalized_track text GENERATED ALWAYS AS (lower(btrim(coalesce(track,'')))) STORED NOT NULL,
  application_instance text NOT NULL DEFAULT 'initial' CHECK (application_instance = btrim(application_instance) AND length(application_instance) BETWEEN 1 AND 200),
  submission_status text NOT NULL DEFAULT 'nao_confirmado' CHECK (submission_status IN ('confirmado','nao_confirmado','nao_enviado')),
  submitted_date career.date_value NOT NULL DEFAULT '{"precision":"unknown","value":null}',
  stage text NOT NULL DEFAULT 'desconhecida' CHECK (stage IN ('desconhecida','candidatura_enviada','triagem','avaliacao','entrevista','proposta','contratacao','rejeicao','desistencia','processo_encerrado')),
  discovery_channel text, submission_platform text, notes text,
  cycle_relation text NOT NULL DEFAULT 'unknown' CHECK (cycle_relation IN ('before_reset','after_reset','unknown')),
  cycle_order bigint CHECK (cycle_order > 0), counting_eligible boolean NOT NULL DEFAULT true,
  archived_at timestamptz, canonical_application_id uuid,
  legacy_registered_date career.date_value NOT NULL DEFAULT '{"precision":"unknown","value":null}',
  legacy_resume_text text,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,legacy_id), UNIQUE (owner_id,display_id), UNIQUE (owner_id,cycle_order),
  CHECK ((legacy_id IS NULL AND display_id ~ '^N[0-9]{6,}$') OR (legacy_id IS NOT NULL AND legacy_id ~ '^V[0-9]+$' AND display_id = legacy_id)),
  CHECK (canonical_application_id IS NULL OR canonical_application_id <> id),
  FOREIGN KEY (owner_id,opportunity_id) REFERENCES career.opportunities(owner_id,id),
  FOREIGN KEY (owner_id,canonical_application_id) REFERENCES career.applications(owner_id,id)
);
CREATE UNIQUE INDEX applications_canonical_identity ON career.applications(owner_id,opportunity_id,normalized_track,application_instance) WHERE canonical_application_id IS NULL;
CREATE INDEX applications_owner_status_date ON career.applications(owner_id,submission_status,((submitted_date->>'value')),id);
CREATE INDEX applications_owner_stage ON career.applications(owner_id,stage,archived_at);

CREATE TABLE career.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  name text, notes text,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id)
);
CREATE TABLE career.links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  opportunity_id uuid, application_id uuid, contact_id uuid,
  original_url text NOT NULL CHECK (length(btrim(original_url)) > 0), comparison_url text,
  kind text NOT NULL CHECK (length(btrim(kind)) > 0),
  is_local boolean NOT NULL DEFAULT false, is_private boolean NOT NULL DEFAULT true,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), CHECK (num_nonnulls(opportunity_id,application_id,contact_id) > 0),
  FOREIGN KEY (owner_id,opportunity_id) REFERENCES career.opportunities(owner_id,id),
  FOREIGN KEY (owner_id,application_id) REFERENCES career.applications(owner_id,id),
  FOREIGN KEY (owner_id,contact_id) REFERENCES career.contacts(owner_id,id)
);
CREATE TABLE career.resume_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  label text, stack text[] NOT NULL DEFAULT '{}', language text, local_ref text,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id)
);
CREATE TABLE career.application_resumes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  application_id uuid NOT NULL, resume_id uuid NOT NULL,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,application_id,resume_id),
  FOREIGN KEY (owner_id,application_id) REFERENCES career.applications(owner_id,id),
  FOREIGN KEY (owner_id,resume_id) REFERENCES career.resume_refs(owner_id,id)
);
CREATE TABLE career.evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('relato_usuario','portal_observado','email','arquivo_local','texto_legado','outro')),
  original_text text, source text, captured_at timestamptz NOT NULL DEFAULT now(),
  occurred_date career.date_value, private_ref text, local_ref text,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id)
);
CREATE TABLE career.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  application_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('envio_confirmado','etapa_alterada','retorno_substantivo','confirmacao_automatica','avaliacao','entrevista','proposta','contratacao','rejeicao','desistencia','encerramento','nota','correcao')),
  state text NOT NULL CHECK (state IN ('convidado','agendado','concluido','informado')),
  occurred_date career.date_value NOT NULL DEFAULT '{"precision":"unknown","value":null}',
  result_text text, score_value numeric, score_unit text, evidence_id uuid, source_text text,
  supersedes_event_id uuid,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,application_id,id), UNIQUE (owner_id,supersedes_event_id),
  CHECK (supersedes_event_id IS NULL OR supersedes_event_id <> id),
  CHECK (score_value IS NULL OR score_value NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  FOREIGN KEY (owner_id,application_id) REFERENCES career.applications(owner_id,id),
  FOREIGN KEY (owner_id,evidence_id) REFERENCES career.evidence(owner_id,id),
  FOREIGN KEY (owner_id,application_id,supersedes_event_id) REFERENCES career.events(owner_id,application_id,id)
);
CREATE INDEX events_application_date ON career.events(owner_id,application_id,((occurred_date->>'value')),id);
CREATE TABLE career.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  application_id uuid, contact_id uuid, title text NOT NULL CHECK (length(btrim(title)) > 0),
  due_date career.date_value NOT NULL DEFAULT '{"precision":"unknown","value":null}',
  completed_date career.date_value NOT NULL DEFAULT '{"precision":"unknown","value":null}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), CHECK (num_nonnulls(application_id,contact_id) > 0),
  FOREIGN KEY (owner_id,application_id) REFERENCES career.applications(owner_id,id),
  FOREIGN KEY (owner_id,contact_id) REFERENCES career.contacts(owner_id,id)
);
CREATE INDEX tasks_owner_due ON career.tasks(owner_id,status,((due_date->>'value')),id);

CREATE TABLE career.cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  reset_date career.date_value NOT NULL DEFAULT '{"precision":"unknown","value":null}',
  reset_marker text, next_order bigint NOT NULL DEFAULT 1 CHECK (next_order > 0),
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id)
);
CREATE TABLE career.batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  cycle_id uuid NOT NULL, batch_number integer NOT NULL CHECK (batch_number > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
  target integer NOT NULL DEFAULT 30 CHECK (target > 0),
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,cycle_id,batch_number),
  FOREIGN KEY (owner_id,cycle_id) REFERENCES career.cycles(owner_id,id)
);
CREATE TABLE career.batch_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  batch_id uuid NOT NULL, application_id uuid NOT NULL, captured_order bigint NOT NULL CHECK (captured_order > 0),
  allocation text NOT NULL DEFAULT 'counted' CHECK (allocation IN ('counted','excluded')),
  eligible boolean NOT NULL DEFAULT true,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,batch_id,application_id), UNIQUE (owner_id,batch_id,captured_order),
  FOREIGN KEY (owner_id,batch_id) REFERENCES career.batches(owner_id,id),
  FOREIGN KEY (owner_id,application_id) REFERENCES career.applications(owner_id,id)
);
CREATE TABLE career.review_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  batch_id uuid NOT NULL, version_number integer NOT NULL CHECK (version_number > 0),
  type text NOT NULL CHECK (type IN ('original','revision','rectification')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  population_ids uuid[] NOT NULL, event_ids uuid[] NOT NULL,
  narrative text, decisions text[] NOT NULL DEFAULT '{}', predecessor_id uuid,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,batch_id,id), UNIQUE (owner_id,batch_id,version_number),
  CHECK (predecessor_id IS NULL OR predecessor_id <> id),
  CHECK ((type = 'original' AND predecessor_id IS NULL) OR (type <> 'original' AND predecessor_id IS NOT NULL)),
  FOREIGN KEY (owner_id,batch_id) REFERENCES career.batches(owner_id,id),
  FOREIGN KEY (owner_id,batch_id,predecessor_id) REFERENCES career.review_versions(owner_id,batch_id,id)
);

CREATE TABLE career.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  importer_version text NOT NULL, source_set_hash career.sha256 NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  pending_issues text[] NOT NULL DEFAULT '{}',
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,source_set_hash,importer_version)
);
CREATE TABLE career.source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  import_run_id uuid NOT NULL, file_name text NOT NULL, file_hash career.sha256 NOT NULL,
  original_bytes bytea NOT NULL, original_text text,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,import_run_id,file_hash),
  FOREIGN KEY (owner_id,import_run_id) REFERENCES career.import_runs(owner_id,id)
);
CREATE TABLE career.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  source_file_id uuid NOT NULL, row_number integer NOT NULL CHECK (row_number > 0),
  row_hash career.sha256 NOT NULL, original_text text NOT NULL, legacy_id text,
  target_application_id uuid,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','imported','skipped','conflict','failed')),
  pending_issues text[] NOT NULL DEFAULT '{}',
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,source_file_id,row_number),
  FOREIGN KEY (owner_id,source_file_id) REFERENCES career.source_files(owner_id,id),
  FOREIGN KEY (owner_id,target_application_id) REFERENCES career.applications(owner_id,id)
);
CREATE TABLE career.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner','agent','import')), actor_id text NOT NULL,
  source text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  entity_type text NOT NULL, entity_id uuid NOT NULL, operation text NOT NULL,
  before_data jsonb, after_data jsonb, diff jsonb NOT NULL, request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (owner_id,id)
);
CREATE INDEX audit_owner_entity_time ON career.audit_log(owner_id,entity_type,entity_id,occurred_at);
CREATE TABLE career.mutation_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner','agent','import')), actor_id text NOT NULL,
  operation text NOT NULL, idempotency_key text NOT NULL, request_hash career.sha256 NOT NULL,
  http_status integer NOT NULL CHECK (http_status BETWEEN 100 AND 599), safe_response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (owner_id,id),
  UNIQUE (owner_id,actor_kind,actor_id,operation,idempotency_key)
);
CREATE TABLE career.agent_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  label text NOT NULL, prefix text NOT NULL, token_hash career.sha256 NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['career:read','career:write','career:reviews','career:export']::text[] AND array_position(scopes,NULL) IS NULL),
  expires_at timestamptz, revoked_at timestamptz,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (token_hash), CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE TABLE career.creation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('application','contact','task','event','agent_credential')),
  client_id uuid NOT NULL, payload_hash career.sha256 NOT NULL,
  result_application_id uuid, result_contact_id uuid, result_task_id uuid, result_event_id uuid, result_credential_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (owner_id,id), UNIQUE (owner_id,entity_type,client_id),
  CHECK (num_nonnulls(result_application_id,result_contact_id,result_task_id,result_event_id,result_credential_id) = 1),
  CHECK ((entity_type = 'application') = (result_application_id IS NOT NULL)),
  CHECK ((entity_type = 'contact') = (result_contact_id IS NOT NULL)),
  CHECK ((entity_type = 'task') = (result_task_id IS NOT NULL)),
  CHECK ((entity_type = 'event') = (result_event_id IS NOT NULL)),
  CHECK ((entity_type = 'agent_credential') = (result_credential_id IS NOT NULL)),
  FOREIGN KEY (owner_id,result_application_id) REFERENCES career.applications(owner_id,id),
  FOREIGN KEY (owner_id,result_contact_id) REFERENCES career.contacts(owner_id,id),
  FOREIGN KEY (owner_id,result_task_id) REFERENCES career.tasks(owner_id,id),
  FOREIGN KEY (owner_id,result_event_id) REFERENCES career.events(owner_id,id),
  FOREIGN KEY (owner_id,result_credential_id) REFERENCES career.agent_credentials(owner_id,id)
);
CREATE TABLE career.opportunity_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  opportunity_id uuid NOT NULL, provider text NOT NULL, tenant text NOT NULL CHECK (length(btrim(tenant)) > 0),
  identity_kind text NOT NULL CHECK (identity_kind IN ('job_code','verified_alias')),
  identity_value text NOT NULL CHECK (length(btrim(identity_value)) > 0), verification_evidence_id uuid,
  normalized_provider text GENERATED ALWAYS AS (lower(btrim(provider))) STORED NOT NULL CHECK (normalized_provider <> ''),
  normalized_tenant text GENERATED ALWAYS AS (btrim(tenant)) STORED NOT NULL,
  normalized_value text GENERATED ALWAYS AS (btrim(identity_value)) STORED NOT NULL,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,normalized_provider,normalized_tenant,identity_kind,normalized_value),
  CHECK (identity_kind <> 'verified_alias' OR verification_evidence_id IS NOT NULL),
  FOREIGN KEY (owner_id,opportunity_id) REFERENCES career.opportunities(owner_id,id),
  FOREIGN KEY (owner_id,verification_evidence_id) REFERENCES career.evidence(owner_id,id)
);

CREATE TABLE career.restore_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  destination_owner_id uuid NOT NULL CHECK (destination_owner_id = owner_id), manifest_hash career.sha256 NOT NULL,
  format_version integer NOT NULL CHECK (format_version > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','restoring','verifying','completed','failed')),
  expected_rows bigint NOT NULL CHECK (expected_rows >= 0), restored_rows bigint NOT NULL DEFAULT 0 CHECK (restored_rows >= 0),
  verified_at timestamptz, failure_text text,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,id,manifest_hash),
  CHECK (restored_rows <= expected_rows), CHECK (state <> 'completed' OR (verified_at IS NOT NULL AND restored_rows = expected_rows))
);

-- Campos fortes já conhecidos participam da mesma exclusão mútua dos aliases.
CREATE FUNCTION career.register_opportunity_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE identity_target uuid;
BEGIN
  IF nullif(btrim(NEW.platform),'') IS NOT NULL AND nullif(btrim(NEW.tenant),'') IS NOT NULL AND nullif(btrim(NEW.job_code),'') IS NOT NULL THEN
    INSERT INTO career.opportunity_identities (owner_id,opportunity_id,provider,tenant,identity_kind,identity_value)
    VALUES (NEW.owner_id,NEW.id,NEW.platform,NEW.tenant,'job_code',NEW.job_code)
    ON CONFLICT (owner_id,normalized_provider,normalized_tenant,identity_kind,normalized_value)
    DO UPDATE SET opportunity_id = career.opportunity_identities.opportunity_id
    RETURNING opportunity_id INTO identity_target;
    IF identity_target <> NEW.id THEN
      RAISE EXCEPTION 'A identidade forte já pertence a outra oportunidade.' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER opportunities_strong_identity AFTER INSERT OR UPDATE OF platform,tenant,job_code ON career.opportunities FOR EACH ROW EXECUTE FUNCTION career.register_opportunity_identity();
CREATE TABLE career.maintenance_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL UNIQUE,
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','restoring','failed')),
  active_restore_run_id uuid, manifest_hash career.sha256,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id),
  CHECK ((state = 'ready' AND active_restore_run_id IS NULL AND manifest_hash IS NULL) OR (state <> 'ready' AND active_restore_run_id IS NOT NULL AND manifest_hash IS NOT NULL)),
  FOREIGN KEY (owner_id,active_restore_run_id,manifest_hash) REFERENCES career.restore_runs(owner_id,id,manifest_hash)
);
CREATE TABLE career.restore_row_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  restore_run_id uuid NOT NULL, table_name text NOT NULL, row_id uuid NOT NULL, row_hash career.sha256 NOT NULL,
  restored_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
  version career.positive_version NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,id), UNIQUE (owner_id,restore_run_id,table_name,row_id),
  CHECK (table_name IN ('owner_settings','opportunities','applications','links','resume_refs','application_resumes','evidence','events','contacts','tasks','cycles','batches','batch_members','review_versions','import_runs','source_files','import_rows','audit_log','opportunity_identities','creation_requests')),
  FOREIGN KEY (owner_id,restore_run_id) REFERENCES career.restore_runs(owner_id,id)
);

-- Invariantes intrínsecas de histórico; INSERT preserva versões/datas históricas.
CREATE FUNCTION career.preserve_application_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.display_id <> OLD.display_id
     OR NEW.legacy_id IS DISTINCT FROM OLD.legacy_id
     OR (OLD.cycle_order IS NOT NULL AND NEW.cycle_order IS DISTINCT FROM OLD.cycle_order)
  THEN RAISE EXCEPTION 'Identificadores e ordens atribuídos são permanentes.' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER applications_identity BEFORE UPDATE ON career.applications FOR EACH ROW EXECUTE FUNCTION career.preserve_application_identity();
CREATE FUNCTION career.preserve_cycle_counter() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.next_order < OLD.next_order THEN RAISE EXCEPTION 'O contador do ciclo não pode retroceder.' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cycles_counter BEFORE UPDATE ON career.cycles FOR EACH ROW EXECUTE FUNCTION career.preserve_cycle_counter();
CREATE FUNCTION career.preserve_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Revisões publicadas são imutáveis; crie outra versão.' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER review_versions_history BEFORE UPDATE OR DELETE ON career.review_versions FOR EACH ROW EXECUTE FUNCTION career.preserve_review();
CREATE FUNCTION career.preserve_closed_batch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status = 'closed' AND (TG_OP = 'DELETE' OR NEW.status <> 'closed' OR NEW.cycle_id <> OLD.cycle_id OR NEW.batch_number <> OLD.batch_number OR NEW.target <> OLD.target OR NEW.owner_id <> OLD.owner_id OR NEW.id <> OLD.id)
  THEN RAISE EXCEPTION 'Lotes fechados preservam composição e identificação.' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER batches_history BEFORE UPDATE OR DELETE ON career.batches FOR EACH ROW EXECUTE FUNCTION career.preserve_closed_batch();
CREATE FUNCTION career.preserve_closed_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE batch_status text;
BEGIN
  -- O lock serializa a alteração do membro com o fechamento concorrente do lote.
  IF TG_OP IN ('UPDATE','DELETE') THEN
    SELECT status INTO batch_status FROM career.batches WHERE owner_id = OLD.owner_id AND id = OLD.batch_id FOR UPDATE;
    IF batch_status = 'closed' THEN RAISE EXCEPTION 'A composição de um lote fechado é permanente.' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO batch_status FROM career.batches WHERE owner_id = NEW.owner_id AND id = NEW.batch_id FOR UPDATE;
    IF batch_status = 'closed' THEN RAISE EXCEPTION 'A composição de um lote fechado é permanente.' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER batch_members_history BEFORE UPDATE OR DELETE ON career.batch_members FOR EACH ROW EXECUTE FUNCTION career.preserve_closed_membership();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA career FROM PUBLIC;
