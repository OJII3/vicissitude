import { describe, expect, it, vi } from "vitest";
import { DiscordClientMessenger } from "./discord-client.js";
import { DiscordEffectExecutor } from "./discord-effect-executor.js";

function client(channel: unknown) {
  return { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as never;
}

describe("DiscordClientMessenger", () => {
  it("validates guild scope, fetches exact target, and replies safely", async () => {
    const reply = vi.fn().mockResolvedValue({ id: "sent" });
    const messages = { fetch: vi.fn().mockResolvedValue({ reply }) };
    const messenger = new DiscordClientMessenger(
      client({ guildId: "g", isTextBased: () => true, isSendable: () => true, messages }),
      "g",
    );
    await expect(
      messenger.reply({
        guildId: "g",
        channelId: "c",
        messageId: "m",
        content: "x",
        nonce: "n",
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).resolves.toEqual({ id: "sent" });
    expect(messages.fetch).toHaveBeenCalledWith("m");
    expect(reply).toHaveBeenCalledWith({
      content: "x",
      nonce: "n",
      enforceNonce: true,
      allowedMentions: { parse: [], repliedUser: false },
    });
  });

  it.each([
    [null, "Target channel not found"],
    [{ guildId: "other", isTextBased: () => true, isSendable: () => true }, "guild"],
    [{ guildId: "g", isTextBased: () => false, isSendable: () => false }, "sendable"],
    [{ guildId: null, isTextBased: () => true, isSendable: () => true }, "DM"],
  ])("rejects unsafe channel before message fetch/send", async (channel, message) => {
    const channelFetch = vi.fn().mockResolvedValue(channel);
    await expect(
      new DiscordClientMessenger({ channels: { fetch: channelFetch } } as never, "g").reply({
        guildId: "g",
        channelId: "c",
        messageId: "m",
        content: "x",
        nonce: "n",
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).rejects.toThrow(message);
    expect(channelFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an input guild before fetching the client channel", async () => {
    const channelFetch = vi.fn();
    const messenger = new DiscordClientMessenger({ channels: { fetch: channelFetch } } as never, "g");
    await expect(
      messenger.reply({
        guildId: "other",
        channelId: "c",
        messageId: "m",
        content: "x",
        nonce: "n",
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).rejects.toThrow("guild");
    expect(channelFetch).not.toHaveBeenCalled();
  });

  it("normalizes preflight failures so the executor marks them definitive", async () => {
    const targetReply = vi.fn();
    const messageFetch = vi.fn().mockRejectedValue(new Error("missing message"));
    const channelFetch = vi.fn().mockResolvedValue({
      guildId: "g",
      isTextBased: () => true,
      isSendable: () => true,
      messages: { fetch: messageFetch },
    });
    const queue = { succeed: vi.fn(), fail: vi.fn(), markUnknown: vi.fn() };
    await new DiscordEffectExecutor(
      new DiscordClientMessenger({ channels: { fetch: channelFetch } } as never, "g"),
      queue,
    ).execute(
      {
        id: "e",
        runId: "r",
        guildId: "g",
        capabilityChannelId: "c",
        targetChannelId: "c",
        targetMessageId: "m",
        content: "x",
        attempts: 1,
      },
      { now: () => new Date() },
    );
    expect(messageFetch).toHaveBeenCalledWith("m");
    expect(targetReply).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith("e", "discord_request_failed", expect.any(Date));
  });

  it("does not normalize an error raised by target.reply", async () => {
    const targetReply = vi.fn().mockRejectedValue(Object.assign(new Error("server"), { status: 500 }));
    const messenger = new DiscordClientMessenger(
      client({
        guildId: "g",
        isTextBased: () => true,
        isSendable: () => true,
        messages: { fetch: vi.fn().mockResolvedValue({ reply: targetReply }) },
      }),
      "g",
    );
    await expect(
      messenger.reply({
        guildId: "g",
        channelId: "c",
        messageId: "m",
        content: "x",
        nonce: "n",
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
