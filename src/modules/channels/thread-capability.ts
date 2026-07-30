import type { ChannelCapabilities } from "./channel-capability.js";

export const THREAD_OVERRIDABLE_CAPABILITIES = ["observeEvents", "respondToMentions", "addReactions"] as const;

export type ThreadOverridableCapability = (typeof THREAD_OVERRIDABLE_CAPABILITIES)[number];

export interface ThreadCapabilityOverride {
  guildId: string;
  channelId: string;
  threadId: string;
  observeEvents: boolean | null;
  respondToMentions: boolean | null;
  addReactions: boolean | null;
}

export function inheritAllOverride(guildId: string, channelId: string, threadId: string): ThreadCapabilityOverride {
  return { guildId, channelId, threadId, observeEvents: null, respondToMentions: null, addReactions: null };
}

export function isInheritOnly(override: ThreadCapabilityOverride): boolean {
  return THREAD_OVERRIDABLE_CAPABILITIES.every((capability) => override[capability] === null);
}

export function resolveEffectiveCapabilities(
  channel: ChannelCapabilities,
  override: ThreadCapabilityOverride | null,
): ChannelCapabilities {
  const resolved = { ...channel };
  for (const capability of THREAD_OVERRIDABLE_CAPABILITIES) {
    const value = override?.[capability] ?? null;
    if (value !== null) resolved[capability] = value;
  }
  return resolved;
}
