export type ChannelRole = "home" | "default";

export interface ChannelConfig {
	channelId: string;
	role: ChannelRole;
	cooldownSeconds: number;
}
