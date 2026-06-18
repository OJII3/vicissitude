import type { DiscordAgent } from "@vicissitude/agent/discord/discord-agent";
import { formatDiscordMessage } from "@vicissitude/agent/discord/message-formatter";
import type { MessageIngestionService } from "@vicissitude/application/message-ingestion-service";
import { discordDmUserIdFromScopeId, discordScopeId } from "@vicissitude/memory/namespace";
import { METRIC, type PrometheusCollector } from "@vicissitude/observability/metrics";
import type { Logger } from "@vicissitude/shared/types";

import type { DiscordGateway } from "../gateway/discord.ts";

export function setupEventHandlers(deps: {
	gateway: DiscordGateway;
	ingestionService: MessageIngestionService;
	metricsCollector: PrometheusCollector;
	agents: Map<string, DiscordAgent>;
	logger: Logger;
	/** 信頼ユーザー (依頼者) 集合。これに含まれる authorId のメッセージに信頼マーカーを付ける */
	trustedUserIds: string[];
}): void {
	const { gateway, ingestionService, metricsCollector, agents, logger, trustedUserIds } = deps;
	gateway.onResume(() => {
		logger.info(`[bootstrap] Discord Gateway resumed; ensuring ${agents.size} conversation loops`);
		for (const agent of agents.values()) agent.ensurePolling();
	});
	gateway.onHomeChannelMessage(async (msg) => {
		const selfUserId = gateway.getClient()?.user?.id;
		const scopeId = msg.scopeId ?? (msg.guildId ? discordScopeId(msg.guildId) : undefined);
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, {
			guild_id: msg.guildId ?? "none",
			channel_type: "home",
			author_type: msg.isBot ? "bot" : "user",
			is_thread: String(msg.isThread),
			has_attachments: String(msg.attachments.length > 0),
		});
		await ingestionService.handleIncomingMessage(msg, {
			recordConversation: true,
		});
		if (msg.guildId && msg.authorId !== selfUserId) {
			const agent = scopeId ? agents.get(scopeId) : undefined;
			if (!agent) {
				logger.warn(`[bootstrap] no agent for guild ${msg.guildId}, message will not be processed`);
			}
			void agent?.send({
				sessionKey: "home",
				message: formatDiscordMessage(msg, { trustedUserIds }),
				scopeId,
				attachments: msg.attachments,
				channelId: msg.channelId,
				isBot: msg.isBot,
			});
		}
	});

	gateway.onMessage(async (msg) => {
		const scopeId = msg.scopeId ?? (msg.guildId ? discordScopeId(msg.guildId) : undefined);
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, {
			guild_id: msg.guildId ?? "none",
			channel_type: "mention",
			author_type: msg.isBot ? "bot" : "user",
			is_thread: String(msg.isThread),
			has_attachments: String(msg.attachments.length > 0),
		});
		await ingestionService.handleIncomingMessage(msg);
		if (msg.guildId && scopeId) {
			const agent = agents.get(scopeId);
			if (!agent) {
				logger.warn(`[bootstrap] no agent for guild ${msg.guildId}, mention will not be processed`);
			}
			void agent?.send({
				sessionKey: "mention",
				message: formatDiscordMessage(msg, { trustedUserIds }),
				scopeId,
				attachments: msg.attachments,
				channelId: msg.channelId,
				isBot: msg.isBot,
			});
		}
	});

	gateway.onDirectMessage(async (msg) => {
		const selfUserId = gateway.getClient()?.user?.id;
		const scopeId = msg.scopeId;
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, {
			guild_id: "none",
			channel_type: "dm",
			author_type: msg.isBot ? "bot" : "user",
			is_thread: String(msg.isThread),
			has_attachments: String(msg.attachments.length > 0),
		});
		await ingestionService.handleIncomingMessage(msg, {
			recordConversation: true,
		});
		if (!scopeId) {
			logger.warn("[bootstrap] DM message has no scopeId, message will not be processed");
			return;
		}
		if (msg.authorId === selfUserId) return;

		const agent = agents.get(scopeId);
		if (!agent) {
			const userId = discordDmUserIdFromScopeId(scopeId) ?? "unknown";
			logger.warn(`[bootstrap] no DM agent for user ${userId}, message will not be processed`);
		}
		void agent?.send({
			sessionKey: "dm",
			message: formatDiscordMessage(msg, { trustedUserIds }),
			scopeId,
			attachments: msg.attachments,
			channelId: msg.channelId,
			isBot: msg.isBot,
		});
	});
}
