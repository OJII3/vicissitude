\set ON_ERROR_STOP on

DO $$
DECLARE
  role_name text;
  table_name text;
  operation text;
  expected boolean;
  actual boolean;
  application_tables constant text[] := ARRAY[
    'schema_migrations', 'system_state', 'channel_capabilities', 'thread_capability_overrides',
    'events', 'jobs', 'character_definitions', 'decision_runs', 'model_calls', 'effects', 'audit_entries'
  ];
  operations constant text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vicissitude_gateway', 'vicissitude_worker'] LOOP
    FOREACH table_name IN ARRAY application_tables LOOP
      FOREACH operation IN ARRAY operations LOOP
        expected := CASE role_name
          WHEN 'vicissitude_gateway' THEN
            (operation = 'SELECT' AND table_name = ANY (ARRAY['schema_migrations', 'system_state', 'channel_capabilities', 'thread_capability_overrides', 'events', 'effects'])) OR
            (operation = 'INSERT' AND table_name = ANY (ARRAY['channel_capabilities', 'thread_capability_overrides', 'events', 'jobs', 'audit_entries'])) OR
            (operation = 'UPDATE' AND table_name = ANY (ARRAY['channel_capabilities', 'thread_capability_overrides', 'effects'])) OR
            (operation = 'DELETE' AND table_name = 'thread_capability_overrides')
          WHEN 'vicissitude_worker' THEN
            (operation = 'SELECT' AND table_name = ANY (ARRAY['schema_migrations', 'system_state', 'events', 'jobs', 'character_definitions', 'decision_runs', 'effects'])) OR
            (operation = 'INSERT' AND table_name = ANY (ARRAY['decision_runs', 'model_calls', 'effects', 'audit_entries'])) OR
            (operation = 'UPDATE' AND table_name = ANY (ARRAY['jobs', 'decision_runs']))
          ELSE false
        END;
        actual := has_table_privilege(role_name, format('public.%I', table_name), operation);
        IF actual IS DISTINCT FROM expected THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = format('privilege/%s/%s/%s', role_name, table_name, operation);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('vicissitude_migrator', 'vicissitude_gateway', 'vicissitude_worker')
      AND (NOT rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)
  ) OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('vicissitude_migrator', 'vicissitude_gateway', 'vicissitude_worker')) <> 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'role attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname IN ('vicissitude_migrator', 'vicissitude_gateway', 'vicissitude_worker')
       OR granted_role.rolname IN ('vicissitude_migrator', 'vicissitude_gateway', 'vicissitude_worker')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'pg_auth_members';
  END IF;

  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) <> 'vicissitude_migrator'
     OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') <> 'vicissitude_migrator'
     OR EXISTS (
       SELECT 1 FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
         AND relation.relname = ANY (application_tables)
         AND pg_get_userbyid(relation.relowner) <> 'vicissitude_migrator'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'owner';
  END IF;

  IF NOT has_database_privilege('vicissitude_gateway', current_database(), 'CONNECT')
     OR NOT has_database_privilege('vicissitude_worker', current_database(), 'CONNECT')
     OR has_database_privilege('vicissitude_gateway', current_database(), 'TEMP')
     OR has_database_privilege('vicissitude_worker', current_database(), 'TEMP')
     OR NOT has_schema_privilege('vicissitude_gateway', 'public', 'USAGE')
     OR NOT has_schema_privilege('vicissitude_worker', 'public', 'USAGE')
     OR has_schema_privilege('vicissitude_gateway', 'public', 'CREATE')
     OR has_schema_privilege('vicissitude_worker', 'public', 'CREATE') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'runtime database/schema privilege';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_database database_entry
    CROSS JOIN LATERAL aclexplode(COALESCE(database_entry.datacl, acldefault('d', database_entry.datdba))) acl
    WHERE database_entry.datname = current_database() AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
    WHERE namespace.nspname = 'public' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_default_acl default_acl
    CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) acl
    WHERE default_acl.defaclrole = 'vicissitude_migrator'::regrole
      AND default_acl.defaclnamespace = 'public'::regnamespace
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PUBLIC/default ACL';
  END IF;
END
$$;
