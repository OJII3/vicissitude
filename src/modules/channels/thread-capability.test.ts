import { describe, expect, it } from "vitest";
import { denyAllCapabilities, type ChannelCapabilities } from "./channel-capability.js";
import {
  resolveEffectiveCapabilities,
  type ThreadCapabilityOverride,
  type ThreadOverridableCapability,
} from "./thread-capability.js";

const channel: ChannelCapabilities = {
  ...denyAllCapabilities("guild-1", "channel-1"),
  observeEvents: true,
  respondToMentions: true,
  createThreads: true,
};

function override(
  patch: Partial<Pick<ThreadCapabilityOverride, ThreadOverridableCapability>>,
): ThreadCapabilityOverride {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    threadId: "thread-1",
    observeEvents: null,
    respondToMentions: null,
    addReactions: null,
    ...patch,
  };
}

describe("resolveEffectiveCapabilities", () => {
  it("returns the channel capabilities unchanged without an override", () => {
    expect(resolveEffectiveCapabilities(channel, null)).toEqual(channel);
  });

  it("inherits the channel value for every null field", () => {
    expect(resolveEffectiveCapabilities(channel, override({}))).toEqual(channel);
  });

  it("denies a capability the parent channel allows", () => {
    expect(resolveEffectiveCapabilities(channel, override({ observeEvents: false }))).toEqual({
      ...channel,
      observeEvents: false,
    });
  });

  it("allows a capability the parent channel denies", () => {
    const quiet: ChannelCapabilities = { ...denyAllCapabilities("guild-1", "channel-1"), observeEvents: false };
    expect(resolveEffectiveCapabilities(quiet, override({ observeEvents: true, respondToMentions: true }))).toEqual({
      ...quiet,
      observeEvents: true,
      respondToMentions: true,
    });
  });

  it("leaves capabilities that are not thread-overridable untouched", () => {
    const resolved = resolveEffectiveCapabilities(channel, override({ addReactions: true }));
    expect(resolved.createThreads).toBe(true);
    expect(resolved.shareFiles).toBe(false);
    expect(resolved.addReactions).toBe(true);
  });

  it("keeps the parent channel id so capability lookups stay stable", () => {
    const resolved = resolveEffectiveCapabilities(channel, override({ observeEvents: false }));
    expect(resolved.channelId).toBe("channel-1");
    expect(resolved.guildId).toBe("guild-1");
  });
});
