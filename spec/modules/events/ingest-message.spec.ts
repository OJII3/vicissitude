import { describe, expect, it, vi } from "vitest";
import { denyAllCapabilities } from "../../../src/modules/channels/channel-capability.js";
import type { CanonicalMessageEvent } from "../../../src/modules/events/canonical-event.js";
import {
  ingestDiscordMessage,
  type ConversationJobDirective,
  type IngestionStore,
} from "../../../src/modules/events/ingest-message.js";
import { FixedClock } from "../../../src/shared/clock.js";

const now = new Date("2026-08-04T00:00:00.000Z");
const clock = new FixedClock(now);
const batch = { batchWindowMs: 8_000, maxWaitMs: 30_000 };
const input = {
  externalEventId: "discord-message-1",
  externalVersion: "0",
  guildId: "g",
  channelId: "c",
  threadId: null,
  actorId: "u",
  actorKind: "human" as const,
  occurredAt: now,
  content: "@bot hi",
  mentionedBot: true,
  mentionIds: ["bot"],
  replyToMessageId: null,
  attachments: [],
};
const allowed = { ...denyAllCapabilities("g", "c"), observeEvents: true, respondToMentions: true };

function fakeStore(result = { duplicate: false, jobQueued: true, jobExtended: false }) {
  const calls: { event: CanonicalMessageEvent; directive: ConversationJobDirective }[] = [];
  const store: IngestionStore = {
    saveEventAndSyncJob: vi.fn(async (event, directive) => {
      calls.push({ event, directive });
      return { eventId: event.id, ...result };
    }),
  };
  return { store, calls };
}

describe("ingestDiscordMessage", () => {
  it("enqueues a scope-keyed conversation_evaluate job for an allowed mention", async () => {
    const { store, calls } = fakeStore();
    const result = await ingestDiscordMessage(input, allowed, "running", batch, store, clock);
    expect(result).toMatchObject({ kind: "accepted", jobQueued: true, jobExtended: false });
    const directive = calls[0]!.directive;
    expect(directive.kind).toBe("enqueue");
    if (directive.kind !== "enqueue") throw new Error("unreachable");
    expect(directive.job).toMatchObject({
      kind: "conversation_evaluate",
      guildId: "g",
      channelId: "c",
      threadId: null,
      triggerEventId: calls[0]!.event.id,
      priority: 100,
      maxWaitMs: 30_000,
      maxAttempts: 3,
    });
    expect(directive.job.firstTriggeredAt).toEqual(now);
    expect(directive.job.availableAt).toEqual(new Date("2026-08-04T00:00:08.000Z"));
  });

  it("extends the queued job for an observed non-mention message", async () => {
    const { store, calls } = fakeStore({ duplicate: false, jobQueued: false, jobExtended: true });
    const result = await ingestDiscordMessage(
      { ...input, mentionedBot: false, mentionIds: [] },
      allowed,
      "running",
      batch,
      store,
      clock,
    );
    expect(result).toMatchObject({ kind: "accepted", jobQueued: false, jobExtended: true });
    const directive = calls[0]!.directive;
    expect(directive.kind).toBe("extend");
    if (directive.kind !== "extend") throw new Error("unreachable");
    expect(directive.extension).toMatchObject({ guildId: "g", channelId: "c", threadId: null, maxWaitMs: 30_000 });
    expect(directive.extension.availableAt).toEqual(new Date("2026-08-04T00:00:08.000Z"));
  });

  it("saves the event without touching jobs while stopped", async () => {
    const { store, calls } = fakeStore({ duplicate: false, jobQueued: false, jobExtended: false });
    const result = await ingestDiscordMessage(input, allowed, "stopped", batch, store, clock);
    expect(result).toMatchObject({ kind: "accepted", jobQueued: false, jobExtended: false });
    expect(calls[0]!.directive).toEqual({ kind: "none" });
  });

  it("enqueues a job while draining", async () => {
    const { store, calls } = fakeStore();
    await expect(ingestDiscordMessage(input, allowed, "draining", batch, store, clock)).resolves.toMatchObject({
      jobQueued: true,
    });
    expect(calls[0]!.directive.kind).toBe("enqueue");
  });

  it("marks a mention in a mention-only channel as mention_only and keeps the retention window", async () => {
    const { store, calls } = fakeStore();
    const mentionOnly = { ...denyAllCapabilities("g", "c"), respondToMentions: true };
    await ingestDiscordMessage(input, mentionOnly, "running", batch, store, clock);
    expect(calls[0]!.event).toMatchObject({
      visibility: "mention_only",
      expiresAt: new Date("2026-09-03T00:00:00.000Z"),
    });
  });

  it("ignores messages outside observed or mention-allowed channels", async () => {
    const { store } = fakeStore();
    const denied = denyAllCapabilities("g", "c");
    await expect(
      ingestDiscordMessage({ ...input, mentionedBot: false }, denied, "running", batch, store, clock),
    ).resolves.toEqual({ kind: "ignored", reason: "channel_not_allowed" });
    expect(store.saveEventAndSyncJob).not.toHaveBeenCalled();
  });

  it.each([
    ["guild", { guildId: "other-guild" }],
    ["channel", { channelId: "other-channel" }],
  ])("ignores messages when the capability is for a different %s", async (_scope, mismatch) => {
    const { store } = fakeStore();
    await expect(
      ingestDiscordMessage(input, { ...allowed, ...mismatch }, "running", batch, store, clock),
    ).resolves.toEqual({ kind: "ignored", reason: "channel_not_allowed" });
    expect(store.saveEventAndSyncJob).not.toHaveBeenCalled();
  });

  it("passes duplicate flags through", async () => {
    const { store } = fakeStore({ duplicate: true, jobQueued: false, jobExtended: false });
    await expect(ingestDiscordMessage(input, allowed, "running", batch, store, clock)).resolves.toMatchObject({
      duplicate: true,
      jobQueued: false,
    });
  });
});
