\set ON_ERROR_STOP on

INSERT INTO channel_capabilities (
  guild_id, channel_id, observe_events, respond_to_mentions, updated_at, updated_by, reason
) VALUES (
  'guild-staging', 'channel-staging', true, true,
  TIMESTAMPTZ '2026-07-25 00:00:00+00', 'staging-validation', 'offline fixture'
);

INSERT INTO thread_capability_overrides (
  guild_id, channel_id, thread_id, observe_events, respond_to_mentions, add_reactions,
  updated_at, updated_by, reason
) VALUES (
  'guild-staging', 'channel-staging', 'thread-staging', true, false, NULL,
  TIMESTAMPTZ '2026-07-25 00:00:00+00', 'staging-validation', 'offline fixture'
);

INSERT INTO character_definitions (character_id, version, status, definition, created_at, created_by)
VALUES (
  'staging-validation', 1, 'production',
  '{"schemaVersion":1,"characterId":"staging-validation","version":1,"name":"検証用キャラクター","language":"ja","systemPrompt":"staging検証専用です。","failureMessages":["検証用の失敗応答です。"]}',
  TIMESTAMPTZ '2026-07-25 00:00:00+00', 'staging-validation'
);

INSERT INTO events (
  id, schema_version, source, external_event_id, external_version, kind, visibility,
  guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at
) VALUES
  ('00000000-0000-0000-0000-000000000001', 1, 'discord', 'staging-primary', '1', 'message.created', 'mention_only',
   'guild-staging', 'channel-staging', 'actor-staging', 'human', TIMESTAMPTZ '2026-07-25 00:00:01+00',
   TIMESTAMPTZ '2026-07-25 00:00:02+00', '{"text":"検証fixture"}', TIMESTAMPTZ '2026-08-24 00:00:02+00'),
  ('00000000-0000-0000-0000-000000000007', 1, 'discord', 'staging-gateway-probe', '1', 'message.created', 'observed',
   'guild-staging', 'channel-staging', 'actor-staging', 'human', TIMESTAMPTZ '2026-07-25 00:00:07+00',
   TIMESTAMPTZ '2026-07-25 00:00:08+00', '{"text":"Gateway probe"}', TIMESTAMPTZ '2026-08-24 00:00:08+00'),
  ('00000000-0000-0000-0000-000000000008', 1, 'discord', 'staging-worker-probe', '1', 'message.created', 'observed',
   'guild-staging', 'channel-staging', 'actor-staging', 'human', TIMESTAMPTZ '2026-07-25 00:00:08+00',
   TIMESTAMPTZ '2026-07-25 00:00:09+00', '{"text":"Worker probe"}', TIMESTAMPTZ '2026-08-24 00:00:09+00');

INSERT INTO jobs (id, kind, event_id, state, available_at, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000002', 'mention_response', '00000000-0000-0000-0000-000000000001', 'queued',
   TIMESTAMPTZ '2026-07-25 00:00:03+00', TIMESTAMPTZ '2026-07-25 00:00:03+00', TIMESTAMPTZ '2026-07-25 00:00:03+00'),
  ('00000000-0000-0000-0000-000000000009', 'mention_response', '00000000-0000-0000-0000-000000000008', 'queued',
   TIMESTAMPTZ '2026-07-25 00:00:09+00', TIMESTAMPTZ '2026-07-25 00:00:09+00', TIMESTAMPTZ '2026-07-25 00:00:09+00');

INSERT INTO decision_runs (
  id, job_id, event_id, character_id, character_version, state, action_kind, reason_codes, model_route_version, started_at
) VALUES (
  '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001', 'staging-validation', 1, 'running', 'reply',
  ARRAY['staging-validation'], 'fixture-route-1', TIMESTAMPTZ '2026-07-25 00:00:04+00'
);

INSERT INTO model_calls (id, run_id, purpose, provider, model, route_version, attempt, state, latency_ms, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003',
  'mention_response', 'fixture', 'fixture-model', 'fixture-route-1', 1, 'succeeded', 1,
  TIMESTAMPTZ '2026-07-25 00:00:05+00'
);

INSERT INTO effects (
  id, run_id, effect_slot, kind, state, guild_id, capability_channel_id, target_channel_id,
  target_message_id, payload, capability_decision, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000003',
  'reply-1', 'discord.reply', 'planned', 'guild-staging', 'channel-staging', 'channel-staging',
  'message-staging', '{"content":"検証用reply"}', '{"allowed":true}',
  TIMESTAMPTZ '2026-07-25 00:00:06+00', TIMESTAMPTZ '2026-07-25 00:00:06+00'
);

INSERT INTO audit_entries (id, category, event_id, job_id, run_id, effect_id, summary, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000006', 'staging.fixture',
  '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000005',
  '{"fixture":true}', TIMESTAMPTZ '2026-07-25 00:00:07+00'
);
