import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "../../../src/shared/clock.js";
import { ingestDiscordMessage, type IngestionStore } from "../../../src/modules/events/ingest-message.js";
import { denyAllCapabilities, type ChannelCapabilities } from "../../../src/modules/channels/channel-capability.js";

const clock = new FixedClock(new Date("2026-07-23T00:00:00.000Z"));
const message = {
  externalEventId: "111",
  externalVersion: "0",
  guildId: "guild-1",
  channelId: "channel-1",
  threadId: null,
  actorId: "user-1",
  actorKind: "human" as const,
  occurredAt: new Date("2026-07-22T23:59:59.000Z"),
  content: "こんにちは",
  mentionedBot: false,
  mentionIds: [] as string[],
  replyToMessageId: null,
  attachments: [] as Array<{ id: string; name: string; contentType: string | null; url: string; size: number }>,
};

function capabilities(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return { ...denyAllCapabilities("guild-1", "channel-1"), ...overrides };
}

describe("ingestDiscordMessage", () => {
  it("does not persist content from a channel with no capability", async () => {
    const saveEventAndMaybeEnqueue = vi.fn();
    const store: IngestionStore = { saveEventAndMaybeEnqueue };
    const result = await ingestDiscordMessage(message, capabilities(), "running", store, clock);
    expect(result).toEqual({ kind: "ignored", reason: "channel_not_allowed" });
    expect(saveEventAndMaybeEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["guild", { guildId: "guild-2" }],
    ["channel", { channelId: "channel-2" }],
  ])("does not persist content when the allowed capability has a different %s", async (_scope, mismatch) => {
    const saveEventAndMaybeEnqueue = vi.fn();
    const result = await ingestDiscordMessage(
      message,
      { ...capabilities({ observeEvents: true }), ...mismatch },
      "running",
      { saveEventAndMaybeEnqueue },
      clock,
    );
    expect(result).toEqual({ kind: "ignored", reason: "channel_not_allowed" });
    expect(saveEventAndMaybeEnqueue).not.toHaveBeenCalled();
  });

  it("stores a mention-only event and queues a response", async () => {
    const saveEventAndMaybeEnqueue = vi.fn().mockResolvedValue({ eventId: "event-1", duplicate: false });
    const result = await ingestDiscordMessage(
      { ...message, mentionedBot: true, mentionIds: ["bot-1"] },
      capabilities({ respondToMentions: true }),
      "running",
      { saveEventAndMaybeEnqueue },
      clock,
    );
    expect(result).toEqual({ kind: "accepted", eventId: "event-1", duplicate: false, jobQueued: true });
    expect(saveEventAndMaybeEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "mention_only", expiresAt: new Date("2026-08-22T00:00:00.000Z") }),
      expect.objectContaining({ kind: "mention_response", priority: 100 }),
    );
  });

  it("stores observed non-mentions without queuing a response", async () => {
    const saveEventAndMaybeEnqueue = vi.fn().mockResolvedValue({ eventId: "event-2", duplicate: false });
    const result = await ingestDiscordMessage(
      message,
      capabilities({ observeEvents: true }),
      "running",
      { saveEventAndMaybeEnqueue },
      clock,
    );
    expect(result).toEqual({ kind: "accepted", eventId: "event-2", duplicate: false, jobQueued: false });
    expect(saveEventAndMaybeEnqueue).toHaveBeenCalledWith(expect.objectContaining({ visibility: "observed" }), null);
  });

  it("persists a mention while stopped but does not queue work", async () => {
    const saveEventAndMaybeEnqueue = vi.fn().mockResolvedValue({ eventId: "event-3", duplicate: false });
    const result = await ingestDiscordMessage(
      { ...message, mentionedBot: true, mentionIds: ["bot-1"] },
      capabilities({ observeEvents: true, respondToMentions: true }),
      "stopped",
      { saveEventAndMaybeEnqueue },
      clock,
    );
    expect(result).toEqual({ kind: "accepted", eventId: "event-3", duplicate: false, jobQueued: false });
  });

  it("stores and queues a human mention while draining", async () => {
    const saveEventAndMaybeEnqueue = vi.fn().mockResolvedValue({ eventId: "event-4", duplicate: false });
    const result = await ingestDiscordMessage(
      { ...message, mentionedBot: true, mentionIds: ["bot-1"] },
      capabilities({ respondToMentions: true }),
      "draining",
      { saveEventAndMaybeEnqueue },
      clock,
    );
    expect(result).toEqual({ kind: "accepted", eventId: "event-4", duplicate: false, jobQueued: true });
    expect(saveEventAndMaybeEnqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "mention_response" }),
    );
  });
});
