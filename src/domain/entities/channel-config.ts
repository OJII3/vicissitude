export type ChannelRole = "home" | "default";

export interface ChannelConfig {
	channelId: string;
	guildId?: string;
	role: ChannelRole;
	cooldownSeconds: number;
}
