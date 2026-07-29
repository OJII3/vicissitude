export interface ChannelCapabilities {
  guildId: string;
  channelId: string;
  observeEvents: boolean;
  respondToMentions: boolean;
  spontaneousJoin: boolean;
  spontaneousTopic: boolean;
  addReactions: boolean;
  createThreads: boolean;
  shareFiles: boolean;
  shareExternalLinks: boolean;
}

export interface EffectiveCapabilityRepository {
  get(guildId: string, channelId: string, threadId: string | null): Promise<ChannelCapabilities>;
}

export function denyAllCapabilities(guildId: string, channelId: string): ChannelCapabilities {
  return {
    guildId,
    channelId,
    observeEvents: false,
    respondToMentions: false,
    spontaneousJoin: false,
    spontaneousTopic: false,
    addReactions: false,
    createThreads: false,
    shareFiles: false,
    shareExternalLinks: false,
  };
}
