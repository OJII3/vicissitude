CREATE TABLE system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'running' CHECK (mode IN ('running', 'draining', 'stopped')),
  updated_at timestamptz NOT NULL, updated_by text NOT NULL, reason text NOT NULL
);
INSERT INTO system_state (singleton, mode, updated_at, updated_by, reason) VALUES (true, 'running', now(), 'migration', 'initial state');

CREATE TABLE channel_capabilities (
  guild_id text NOT NULL, channel_id text NOT NULL,
  observe_events boolean NOT NULL DEFAULT false, respond_to_mentions boolean NOT NULL DEFAULT false,
  spontaneous_join boolean NOT NULL DEFAULT false, spontaneous_topic boolean NOT NULL DEFAULT false,
  add_reactions boolean NOT NULL DEFAULT false, create_threads boolean NOT NULL DEFAULT false,
  share_files boolean NOT NULL DEFAULT false, share_external_links boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL, updated_by text NOT NULL, reason text NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE character_definitions (
  character_id text NOT NULL, version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'production', 'retired')), definition jsonb NOT NULL,
  created_at timestamptz NOT NULL, created_by text NOT NULL, PRIMARY KEY (character_id, version)
);
CREATE UNIQUE INDEX one_production_character_version ON character_definitions (character_id) WHERE status = 'production';

CREATE TABLE events (
  id uuid PRIMARY KEY, schema_version integer NOT NULL, source text NOT NULL CHECK (source = 'discord'),
  external_event_id text NOT NULL, external_version text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('message.created', 'message.updated', 'message.deleted')),
  visibility text NOT NULL CHECK (visibility IN ('observed', 'mention_only')),
  guild_id text NOT NULL, channel_id text NOT NULL, thread_id text, actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'bot')), occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL, content jsonb NOT NULL, expires_at timestamptz NOT NULL,
  UNIQUE (source, external_event_id, external_version)
);
CREATE INDEX events_expires_at_idx ON events (expires_at);
CREATE INDEX events_scope_time_idx ON events (guild_id, channel_id, occurred_at DESC);

CREATE TABLE jobs (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('mention_response')), event_id uuid NOT NULL REFERENCES events(id),
  priority integer NOT NULL DEFAULT 0, state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL, leased_until timestamptz, lease_owner text, lease_token uuid, attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0), last_error text, created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL, UNIQUE (kind, event_id)
);
CREATE INDEX jobs_claim_idx ON jobs (state, available_at, priority DESC, created_at);

CREATE TABLE decision_runs (
  id uuid PRIMARY KEY, job_id uuid NOT NULL UNIQUE REFERENCES jobs(id), event_id uuid NOT NULL REFERENCES events(id),
  character_id text NOT NULL, character_version integer NOT NULL, state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  action_kind text CHECK (action_kind IN ('reply')), reason_codes text[] NOT NULL DEFAULT '{}', model_route_version text NOT NULL,
  error text, started_at timestamptz NOT NULL, finished_at timestamptz
);
CREATE TABLE model_calls (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES decision_runs(id), purpose text NOT NULL, provider text NOT NULL,
  model text NOT NULL, route_version text NOT NULL, attempt integer NOT NULL,
  state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'aborted')), input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0, cache_read_tokens integer NOT NULL DEFAULT 0, cache_write_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_usd double precision NOT NULL DEFAULT 0, latency_ms integer NOT NULL, fallback_from text,
  structured_output_failure boolean NOT NULL DEFAULT false, error text, created_at timestamptz NOT NULL
);
CREATE TABLE effects (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES decision_runs(id), effect_slot text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discord.reply')), state text NOT NULL CHECK (state IN ('planned', 'executing', 'succeeded', 'failed', 'unknown')),
  guild_id text NOT NULL, capability_channel_id text NOT NULL, target_channel_id text NOT NULL, target_message_id text NOT NULL,
  payload jsonb NOT NULL, capability_decision jsonb NOT NULL, external_resource_id text, executor_id text,
  attempts integer NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE (run_id, effect_slot)
);
CREATE INDEX effects_claim_idx ON effects (state, created_at);
CREATE TABLE audit_entries (
  id uuid PRIMARY KEY, category text NOT NULL, event_id uuid REFERENCES events(id), job_id uuid REFERENCES jobs(id),
  run_id uuid REFERENCES decision_runs(id), effect_id uuid REFERENCES effects(id), summary jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX audit_entries_run_idx ON audit_entries (run_id, created_at);
CREATE INDEX audit_entries_effect_idx ON audit_entries (effect_id, created_at);
