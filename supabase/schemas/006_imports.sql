-- O baseline é a versão realmente aplicada/reconciliada, nunca a versão vista em um skip.
ALTER TABLE career.import_rows ADD COLUMN applied_target_version career.positive_version;
ALTER TABLE career.import_rows ADD COLUMN resolution jsonb;
ALTER TABLE career.import_rows ADD COLUMN unit_result jsonb;
ALTER TABLE career.import_rows ADD CHECK ((result IN ('imported','skipped')) = (applied_target_version IS NOT NULL AND target_application_id IS NOT NULL AND unit_result IS NOT NULL));
ALTER TABLE career.import_runs ADD COLUMN unit_state jsonb NOT NULL DEFAULT '{}';
-- Nomes distintos podem conter exatamente os mesmos bytes; preserve ambos.
ALTER TABLE career.source_files DROP CONSTRAINT source_files_owner_id_import_run_id_file_hash_key;
ALTER TABLE career.source_files ADD UNIQUE(owner_id,import_run_id,file_name);
