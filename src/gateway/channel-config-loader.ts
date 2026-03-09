interface ChannelConfigData {
	defaultCooldownSeconds: number;
	channels: Array<{
		channelId: string;
		guildId: string;
		guildName?: string;
		channelName?: string;
		role: "home" | "default";
		cooldownSeconds?: number;
	}>;
}

export type { ChannelConfigData };

export class ChannelConfigLoader {
	private readonly configs: Map<string, { guildId: string; role: "home" | "default" }>;

	constructor(json: ChannelConfigData) {
		this.configs = new Map();
		for (const ch of json.channels) {
			this.configs.set(ch.channelId, { guildId: ch.guildId, role: ch.role });
		}
	}

	getGuildIds(): string[] {
		const guildIds = new Set<string>();
		for (const config of this.configs.values()) {
			guildIds.add(config.guildId);
		}
		return [...guildIds];
	}

	getHomeChannelIds(): string[] {
		const ids: string[] = [];
		for (const [id, config] of this.configs) {
			if (config.role === "home") ids.push(id);
		}
		return ids;
	}
}
