\set ON_ERROR_STOP on

DO $$
DECLARE
  index_name text;
BEGIN
  FOREACH index_name IN ARRAY ARRAY[
    'one_production_character_version', 'events_expires_at_idx', 'events_scope_time_idx',
    'events_thread_scope_time_idx', 'jobs_claim_idx', 'effects_claim_idx', 'audit_entries_run_idx',
    'audit_entries_effect_idx'
  ] LOOP
    IF to_regclass(format('public.%I', index_name)) IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = format('index/%s', index_name);
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'p') <> 11
     OR (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'u') < 4
     OR (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c') < 10
     OR (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'f') <> 9 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'constraint inventory';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM events event
    JOIN jobs job ON job.event_id = event.id
    JOIN decision_runs run ON run.job_id = job.id AND run.event_id = event.id
    JOIN model_calls model_call ON model_call.run_id = run.id
    JOIN effects effect ON effect.run_id = run.id
    JOIN audit_entries audit ON audit.event_id = event.id AND audit.job_id = job.id
      AND audit.run_id = run.id AND audit.effect_id = effect.id
    WHERE event.id = '00000000-0000-0000-0000-000000000001'
      AND job.id = '00000000-0000-0000-0000-000000000002'
      AND run.id = '00000000-0000-0000-0000-000000000003'
      AND model_call.id = '00000000-0000-0000-0000-000000000004'
      AND effect.id = '00000000-0000-0000-0000-000000000005'
      AND audit.id = '00000000-0000-0000-0000-000000000006'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'audit linkage';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '0001' AND name = 'durable_spine' AND checksum ~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'schema_migrations';
  END IF;
END
$$;
