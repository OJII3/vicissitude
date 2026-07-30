CREATE TABLE thread_capability_overrides (
  guild_id text NOT NULL, channel_id text NOT NULL, thread_id text NOT NULL,
  observe_events boolean, respond_to_mentions boolean, add_reactions boolean,
  updated_at timestamptz NOT NULL, updated_by text NOT NULL, reason text NOT NULL,
  PRIMARY KEY (guild_id, channel_id, thread_id),
  CHECK (observe_events IS NOT NULL OR respond_to_mentions IS NOT NULL OR add_reactions IS NOT NULL)
);

CREATE INDEX events_thread_scope_time_idx ON events (guild_id, channel_id, thread_id, occurred_at DESC);

ALTER TABLE effects ADD COLUMN thread_id text;
UPDATE effects SET thread_id = target_channel_id WHERE target_channel_id <> capability_channel_id;
