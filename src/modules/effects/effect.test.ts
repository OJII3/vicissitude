import { describe, expect, it, vi } from "vitest";
import { DiscordEffectExecutor } from "../../adapters/discord/discord-effect-executor.js";
import { effectNonce, type ClaimedReplyEffect } from "./effect.js";
import type { Clock } from "../../shared/clock.js";

const effect: ClaimedReplyEffect = {
  id: "effect-1",
  runId: "run-1",
  guildId: "guild-1",
  capabilityChannelId: "cap-1",
  targetChannelId: "target-1",
  threadId: "target-1",
  targetMessageId: "message-1",
  content: "hello",
  attempts: 1,
};

describe("DiscordEffectExecutor", () => {
  it("replies to the exact target with a nonce and succeeds", async () => {
    const reply = vi.fn().mockResolvedValue({ id: "discord-1" });
    const queue = { succeed: vi.fn(), fail: vi.fn(), markUnknown: vi.fn() };
    await new DiscordEffectExecutor({ reply }, queue).execute(effect, { now: () => new Date("2026-01-01T00:00:00Z") });
    expect(reply).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "target-1",
      messageId: "message-1",
      content: "hello",
      nonce: effectNonce("effect-1"),
      enforceNonce: true,
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(queue.succeed).toHaveBeenCalledWith("effect-1", "discord-1", expect.any(Date));
    expect(queue.fail).not.toHaveBeenCalled();
    expect(queue.markUnknown).not.toHaveBeenCalled();
  });

  it("fails definitive Discord REST errors without marking unknown", async () => {
    const queue = { succeed: vi.fn(), fail: vi.fn(), markUnknown: vi.fn() };
    const error = Object.assign(new Error("bad request"), { status: 400 });
    await new DiscordEffectExecutor({ reply: vi.fn().mockRejectedValue(error) }, queue).execute(effect, {
      now: () => new Date(),
    });
    expect(queue.fail).toHaveBeenCalledWith("effect-1", "discord_request_failed", expect.any(Date));
    expect(queue.markUnknown).not.toHaveBeenCalled();
  });

  it("marks network errors unknown without failing", async () => {
    const queue = { succeed: vi.fn(), fail: vi.fn(), markUnknown: vi.fn() };
    await new DiscordEffectExecutor({ reply: vi.fn().mockRejectedValue(new Error("secret timeout")) }, queue).execute(
      effect,
      { now: () => new Date() },
    );
    expect(queue.markUnknown).toHaveBeenCalledWith("effect-1", "discord_delivery_unknown", expect.any(Date));
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("uses completion time and propagates transition failures", async () => {
    let current = new Date("2026-01-01T00:00:00Z");
    const clock: Clock = { now: () => current };
    const queue = { succeed: vi.fn().mockRejectedValue(new Error("db")), fail: vi.fn(), markUnknown: vi.fn() };
    const reply = vi.fn().mockImplementation(async () => {
      current = new Date("2026-01-01T00:00:01Z");
      return { id: "d" };
    });
    await new DiscordEffectExecutor({ reply }, queue).execute(effect, clock);
    expect(queue.markUnknown).toHaveBeenCalledWith(
      "effect-1",
      "effect_state_persistence_failed",
      new Date("2026-01-01T00:00:01Z"),
    );
    queue.markUnknown.mockRejectedValue(new Error("db2"));
    await expect(new DiscordEffectExecutor({ reply }, queue).execute(effect, clock)).rejects.toBeInstanceOf(
      AggregateError,
    );
  });
});
