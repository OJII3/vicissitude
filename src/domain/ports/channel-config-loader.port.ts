import type { ChannelRole } from "../entities/channel-config.ts";

export interface ChannelConfigLoader {
	getRole(channelId: string): ChannelRole;
	getCooldown(channelId: string): number;
	getGuildId(channelId: string): string | undefined;
}
