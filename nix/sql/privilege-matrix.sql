DO $$ DECLARE r text; t text; p text; want boolean; BEGIN
FOR r IN SELECT unnest(ARRAY['vicissitude_gateway','vicissitude_worker']) LOOP FOR t IN SELECT unnest(ARRAY['schema_migrations','system_state','channel_capabilities','events','jobs','character_definitions','decision_runs','model_calls','effects','audit_entries']) LOOP FOR p IN SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) LOOP
want := has_table_privilege(r, format('public.%I', t), p); IF want IS NULL THEN RAISE EXCEPTION 'privilege lookup failed'; END IF;
END LOOP; END LOOP; END LOOP; END $$;
