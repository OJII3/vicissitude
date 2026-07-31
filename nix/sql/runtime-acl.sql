\set ON_ERROR_STOP on

REVOKE ALL PRIVILEGES ON DATABASE vicissitude FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, vicissitude_gateway, vicissitude_worker;

ALTER DATABASE vicissitude OWNER TO vicissitude_migrator;
ALTER SCHEMA public OWNER TO vicissitude_migrator;

GRANT CONNECT ON DATABASE vicissitude TO vicissitude_gateway, vicissitude_worker;
GRANT USAGE ON SCHEMA public TO vicissitude_gateway, vicissitude_worker;

GRANT SELECT ON schema_migrations, system_state, channel_capabilities, thread_capability_overrides, events, effects TO vicissitude_gateway;
GRANT INSERT ON channel_capabilities, thread_capability_overrides, events, jobs, audit_entries TO vicissitude_gateway;
GRANT UPDATE ON channel_capabilities, thread_capability_overrides, effects TO vicissitude_gateway;
-- Resetting every thread override to inherit deletes the row; no other table needs DELETE.
GRANT DELETE ON thread_capability_overrides TO vicissitude_gateway;

GRANT SELECT ON schema_migrations, system_state, events, jobs, character_definitions, decision_runs, effects TO vicissitude_worker;
GRANT INSERT ON decision_runs, model_calls, effects, audit_entries TO vicissitude_worker;
GRANT UPDATE ON jobs, decision_runs TO vicissitude_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE vicissitude_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vicissitude_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vicissitude_migrator IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
