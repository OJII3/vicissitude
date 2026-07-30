import type { ChannelCapabilities, EffectiveCapabilityRepository } from "../../modules/channels/channel-capability.js";
import { resolveEffectiveCapabilities } from "../../modules/channels/thread-capability.js";
import type { PostgresChannelCapabilityRepository } from "./channel-capability-repository.js";
import type { PostgresThreadCapabilityRepository } from "./thread-capability-repository.js";

export class PostgresEffectiveCapabilityRepository implements EffectiveCapabilityRepository {
  public constructor(
    private readonly channels: PostgresChannelCapabilityRepository,
    private readonly threads: PostgresThreadCapabilityRepository,
  ) {}

  public async get(guildId: string, channelId: string, threadId: string | null): Promise<ChannelCapabilities> {
    const channel = await this.channels.get(guildId, channelId);
    if (threadId === null) return channel;
    const override = await this.threads.get(guildId, channelId, threadId);
    return resolveEffectiveCapabilities(channel, override);
  }
}
