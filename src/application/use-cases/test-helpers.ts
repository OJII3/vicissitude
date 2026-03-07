import { mock } from "bun:test";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { HeartbeatConfig } from "../../domain/entities/heartbeat-config.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { HeartbeatConfigRepository } from "../../domain/ports/heartbeat-config-repository.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage, MessageChannel } from "../../domain/ports/message-gateway.port.ts";

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
		attachments: [],
		timestamp: new Date("2026-03-01T06:30:00Z"),
		isBot: false,
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
