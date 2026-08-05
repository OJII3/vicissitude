import { describe, expect, it } from "vitest";
import { toDiscordMessageInput, toTypingScope } from "./message-snapshot.js";

const base = {
  id: "m",
  guildId: "g",
  channelId: "c",
  parentChannelId: null,
  isThread: false,
  authorId: "u",
  authorIsBot: false,
  createdTimestamp: 1_774_742_400_000,
  content: "hello",
  mentionedUserIds: [],
  replyToMessageId: null,
  attachments: [{ id: "a", name: "x", contentType: null, url: "https://x", size: 1 }],
};

describe("toDiscordMessageInput", () => {
  it("maps a guild thread to its parent capability scope", () => {
    expect(
      toDiscordMessageInput({ ...base, channelId: "thread", parentChannelId: "parent", isThread: true }, "bot"),
    ).toMatchObject({
      externalEventId: "m",
      externalVersion: "0",
      guildId: "g",
      channelId: "parent",
      threadId: "thread",
      actorKind: "human",
      occurredAt: new Date(1_774_742_400_000),
      mentionedBot: false,
    });
  });

  it("maps normal channels and bot nonmentions", () => {
    expect(toDiscordMessageInput({ ...base, authorIsBot: true }, "bot")).toMatchObject({
      channelId: "c",
      threadId: null,
      actorKind: "bot",
      mentionedBot: false,
    });
  });

  it("defensively copies mentions and attachments", () => {
    const snapshot = { ...base, mentionedUserIds: ["bot"], attachments: [...base.attachments] };
    const result = toDiscordMessageInput(snapshot, "bot");
    snapshot.mentionedUserIds.push("other");
    snapshot.attachments[0]!.name = "changed";
    expect(result.mentionIds).toEqual(["bot"]);
    expect(result.attachments[0]!.name).toBe("x");
  });

  it.each([
    [{ ...base, guildId: null }, "DM events are outside MVP scope"],
    [{ ...base, isThread: true, parentChannelId: null }, "Thread message has no parent channel"],
    [{ ...base, createdTimestamp: Number.NaN }, "valid timestamp"],
    [{ ...base, id: "" }, "message ID"],
    [{ ...base, authorId: "" }, "author ID"],
  ] as const)("rejects invalid boundary data", (snapshot, message) => {
    expect(() => toDiscordMessageInput(snapshot, "bot")).toThrow(message);
  });
});

describe("toTypingScope", () => {
  it("maps a thread typing event to the parent-channel scope with threadId", () => {
    expect(
      toTypingScope({ guildId: "g", channelId: "t", parentChannelId: "c", isThread: true, userIsBot: false }),
    ).toEqual({ guildId: "g", channelId: "c", threadId: "t" });
  });
  it("maps a plain channel typing event", () => {
    expect(
      toTypingScope({ guildId: "g", channelId: "c", parentChannelId: null, isThread: false, userIsBot: false }),
    ).toEqual({ guildId: "g", channelId: "c", threadId: null });
  });
  it("returns null for DMs, bots, and threads without a parent", () => {
    expect(
      toTypingScope({ guildId: null, channelId: "c", parentChannelId: null, isThread: false, userIsBot: false }),
    ).toBeNull();
    expect(
      toTypingScope({ guildId: "g", channelId: "c", parentChannelId: null, isThread: false, userIsBot: true }),
    ).toBeNull();
    expect(
      toTypingScope({ guildId: "g", channelId: "t", parentChannelId: null, isThread: true, userIsBot: false }),
    ).toBeNull();
  });
});
