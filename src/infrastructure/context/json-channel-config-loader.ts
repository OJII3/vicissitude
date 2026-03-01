import type { ChannelConfig, ChannelRole } from "../../domain/entities/channel-config.ts";
import type { ChannelConfigLoader } from "../../domain/ports/channel-config-loader.port.ts";

interface ChannelsJson {
	defaultCooldownSeconds: number;
	channels: Array<{
		channelId: string;
		guildId?: string;
		role: ChannelRole;
		cooldownSeconds?: number;
	}>;
}

export class JsonChannelConfigLoader implements ChannelConfigLoader {
	private readonly configs: Map<string, ChannelConfig>;
	private readonly defaultCooldownSeconds: number;

	constructor(json: ChannelsJson) {
		this.defaultCooldownSeconds = json.defaultCooldownSeconds;
		this.configs = new Map();
		for (const ch of json.channels) {
			this.configs.set(ch.channelId, {
				channelId: ch.channelId,
				guildId: ch.guildId,
				role: ch.role,
				cooldownSeconds: ch.cooldownSeconds ?? json.defaultCooldownSeconds,
			});
		}
	}

	getRole(channelId: string): ChannelRole {
		return this.configs.get(channelId)?.role ?? "default";
	}

	getCooldown(channelId: string): number {
		return this.configs.get(channelId)?.cooldownSeconds ?? this.defaultCooldownSeconds;
	}

	getGuildId(channelId: string): string | undefined {
		return this.configs.get(channelId)?.guildId;
	}

	/**
	 * ホームチャンネルとして登録された全チャンネルIDを返す。
	 */
	getHomeChannelIds(): string[] {
		const ids: string[] = [];
		for (const [id, config] of this.configs) {
			if (config.role === "home") ids.push(id);
		}
		return ids;
	}
}
