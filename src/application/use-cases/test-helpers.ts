import { mock } from "bun:test";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { ConversationContext } from "../../domain/entities/conversation-context.ts";
import type { EmojiInfo } from "../../domain/entities/emoji-info.ts";
import type { EmojiUsageCount } from "../../domain/entities/emoji-usage.ts";
import type { HeartbeatConfig } from "../../domain/entities/heartbeat-config.ts";
import type { ResponseDecision } from "../../domain/entities/response-decision.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { ChannelConfigLoader } from "../../domain/ports/channel-config-loader.port.ts";
import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";
import type { EmojiProvider } from "../../domain/ports/emoji-provider.port.ts";
import type { EmojiUsageTracker } from "../../domain/ports/emoji-usage-tracker.port.ts";
import type { HeartbeatConfigRepository } from "../../domain/ports/heartbeat-config-repository.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage, MessageChannel } from "../../domain/ports/message-gateway.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";

export function createMockAgent(response: AgentResponse): AiAgent {
	return {
		send: mock(() => Promise.resolve(response)),
		stop: mock(() => {}),
	};
}

export function createMockLogger(): Logger {
	return {
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
	};
}

export function createMockMessage(
	content: string,
	overrides?: Partial<IncomingMessage>,
): IncomingMessage {
	return {
		platform: "test",
		channelId: "ch-1",
		authorId: "user-1",
		authorName: "TestUser",
		messageId: "msg-1",
		content,
		timestamp: new Date("2026-03-01T06:30:00Z"),
		isMentioned: true,
		isThread: false,
		reply: mock(() => Promise.resolve()),
		react: mock(() => Promise.resolve()),
		...overrides,
	};
}

export function createMockChannel(): MessageChannel {
	return {
		sendTyping: mock(() => Promise.resolve()),
		send: mock(() => Promise.resolve()),
	};
}

export function createMockJudge(decision: ResponseDecision): ResponseJudge {
	return {
		judge: mock(() => Promise.resolve(decision)),
	};
}

export function createMockHistory(context?: ConversationContext): ConversationHistory {
	return {
		getRecent: mock((_channelId: string, _limit: number, _excludeMessageId?: string) =>
			Promise.resolve(context ?? { channelId: "ch-1", messages: [] }),
		),
	};
}

export function createMockChannelConfig(cooldown = 60): ChannelConfigLoader {
	return {
		getRole: mock(() => "home" as const),
		getCooldown: mock(() => cooldown),
		getGuildIds: mock(() => []),
	};
}

export function createMockEmojiProvider(emojis: EmojiInfo[] = []): EmojiProvider {
	return {
		getGuildEmojis: mock(() => Promise.resolve(emojis)),
	};
}

export function createMockEmojiUsageTracker(
	data: Record<string, EmojiUsageCount[]> = {},
): EmojiUsageTracker {
	return {
		increment: mock(() => {}),
		getTopEmojis: mock((guildId: string, limit: number) => (data[guildId] ?? []).slice(0, limit)),
		hasData: mock((guildId: string) => (data[guildId] ?? []).length > 0),
	};
}

export function createMockHeartbeatConfigRepository(
	config?: HeartbeatConfig,
): HeartbeatConfigRepository {
	const defaultConfig: HeartbeatConfig = {
		baseIntervalMinutes: 1,
		reminders: [],
	};
	return {
		load: mock(() => Promise.resolve(structuredClone(config ?? defaultConfig))),
		save: mock(() => Promise.resolve()),
	};
}
