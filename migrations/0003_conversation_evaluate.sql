ALTER TABLE jobs
  ADD COLUMN guild_id text,
  ADD COLUMN channel_id text,
  ADD COLUMN thread_id text,
  ADD COLUMN first_triggered_at timestamptz,
  ADD COLUMN trigger_event_id uuid REFERENCES events(id);

UPDATE jobs SET
  guild_id = events.guild_id, channel_id = events.channel_id, thread_id = events.thread_id,
  first_triggered_at = jobs.created_at, trigger_event_id = jobs.event_id, kind = 'conversation_evaluate'
FROM events WHERE events.id = jobs.event_id;

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('conversation_evaluate'));
ALTER TABLE jobs
  ALTER COLUMN guild_id SET NOT NULL,
  ALTER COLUMN channel_id SET NOT NULL,
  ALTER COLUMN first_triggered_at SET NOT NULL;
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_event_id_key;
ALTER TABLE jobs DROP COLUMN event_id;

-- 部分 unique を張る前に、同一 scope の queued 重複は最新だけ残して cancel する（本番運用前の最小移行）
UPDATE jobs SET state = 'cancelled', updated_at = now()
WHERE state = 'queued' AND id NOT IN (
  SELECT DISTINCT ON (guild_id, channel_id, COALESCE(thread_id, '')) id
  FROM jobs WHERE state = 'queued'
  ORDER BY guild_id, channel_id, COALESCE(thread_id, ''), created_at DESC
);
CREATE UNIQUE INDEX jobs_scope_queued_idx
  ON jobs (kind, guild_id, channel_id, (COALESCE(thread_id, ''))) WHERE state = 'queued';

CREATE TABLE conversation_cursors (
  guild_id text NOT NULL, channel_id text NOT NULL,
  thread_id text NOT NULL DEFAULT '',  -- '' = 親チャンネル scope（PK にするため NULL の代わり）
  last_event_id uuid NOT NULL, last_occurred_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (guild_id, channel_id, thread_id)
);

CREATE TABLE run_input_events (
  run_id uuid NOT NULL REFERENCES decision_runs(id),
  event_id uuid NOT NULL REFERENCES events(id),
  PRIMARY KEY (run_id, event_id)
);

CREATE TABLE actor_states (
  guild_id text NOT NULL, actor_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('observed', 'interacted')),
  first_observed_at timestamptz NOT NULL, last_interacted_at timestamptz,
  PRIMARY KEY (guild_id, actor_id)
);
