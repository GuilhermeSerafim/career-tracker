-- Vincula a retomada à identidade do destino; runs antigos não ganham autorização implícita.
ALTER TABLE career.restore_runs ADD COLUMN destination_key career.sha256;
-- Somente manutenção pode reposicionar o contador de IDs após verificação completa.
GRANT SELECT,UPDATE ON SEQUENCE career.application_display_sequence TO career_restore;

-- Replay restaura o registro forte original, sem gerar identidade derivada.
CREATE OR REPLACE FUNCTION career.register_opportunity_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE identity_target uuid;
BEGIN
  IF session_user='career_restore' THEN
    IF career.restore_insert_allowed(NEW.owner_id) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Restauração não autorizada.' USING ERRCODE='42501';
  END IF;
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
ALTER FUNCTION career.register_opportunity_identity() OWNER TO career_schema_owner;
REVOKE ALL ON FUNCTION career.register_opportunity_identity() FROM PUBLIC,career_api,career_restore;
