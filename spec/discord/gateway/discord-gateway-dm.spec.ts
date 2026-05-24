/* oxlint-disable require-await, no-constructor-return, typescript/no-floating-promises -- テスト用モック */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { discordDmScopeId } from "@vicissitude/shared/namespace";
import type { IncomingMessage, Logger } from "@vicissitude/shared/types";
import { Collection, Events } from "discord.js";

import { DiscordGateway } from "../../../apps/discord/src/gateway/discord";

function createMockClient() {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

	const mockClient = {
		user: { id: "bot-user-id", tag: "TestBot#0001" },
		login: mock(async () => {}),
		destroy: mock(() => {}),
		once: mock((event: string, cb: (...args: unknown[]) => void) => {
			if (event === (Events.ClientReady as string)) {
				cb(mockClient);
			}
		}),
		on: mock((event: string, cb: (...args: unknown[]) => void) => {
			const existing = listeners.get(event) ?? [];
			existing.push(cb);
			listeners.set(event, existing);
		}),
		channels: {
			fetch: mock((_id: string) => Promise.resolve(null)),
		},
	};

	function emit(event: string, ...args: unknown[]) {
		for (const cb of listeners.get(event) ?? []) {
			cb(...args);
		}
	}

	return { mockClient, emit };
}

function createDmMessage(overrides: {
	authorId?: string;
	authorBot?: boolean;
	content?: string;
	recipientId?: string;
}) {
	const authorId = overrides.authorId ?? "111";
	return {
		id: `msg-${Math.random().toString(36).slice(2, 8)}`,
		author: {
			id: authorId,
			username: authorId === "bot-user-id" ? "bot" : "testuser",
			displayName: authorId === "bot-user-id" ? "Bot" : "Test User",
			bot: overrides.authorBot ?? false,
		},
		member: null,
		channel: {
			id: "dm-channel-1",
			recipientId: overrides.recipientId ?? authorId,
			isThread: () => false,
			sendTyping: mock(async () => {}),
			send: mock(async () => {}),
		},
		guildId: null,
		content: overrides.content ?? "hello dm",
		mentions: { has: () => false, members: null, users: { get: () => null } },
		createdAt: new Date(),
		attachments: new Collection(),
		react: mock(async () => {}),
		reply: mock(async () => {}),
	};
}

function createSilentLogger(): Logger {
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		error: () => {},
		warn: () => {},
		child: () => logger,
	};
	return logger;
}

let currentMockClient: ReturnType<typeof createMockClient>;

mock.module("discord.js", () => {
	// oxlint-disable-next-line typescript/no-require-imports
	const actual = require("discord.js");
	// oxlint-disable-next-line typescript/no-unsafe-return
	return {
		...actual,
		// oxlint-disable-next-line no-constructor-return, typescript/no-extraneous-class
		Client: class MockedClient {
			constructor() {
				const { mockClient } = currentMockClient;
				return mockClient as unknown as MockedClient;
			}
		},
	};
});

describe("DiscordGateway - DM", () => {
	let gateway: DiscordGateway;
	let mockSetup: ReturnType<typeof createMockClient>;

	beforeEach(() => {
		mockSetup = createMockClient();
		currentMockClient = mockSetup;
		gateway = new DiscordGateway("fake-token", createSilentLogger());
	});

	afterEach(() => {
		gateway.stop();
	});

	it("許可済みユーザーの DM を directMessageHandler に流す", async () => {
		gateway.setAllowedDirectMessageUserIds(["111"]);
		const captured: IncomingMessage[] = [];
		gateway.onDirectMessage(async (msg) => {
			captured.push(msg);
		});

		await gateway.start();
		mockSetup.emit(Events.MessageCreate, createDmMessage({ authorId: "111" }));
		await Bun.sleep(50);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.scopeId).toBe(discordDmScopeId("111"));
	});

	it("未許可ユーザーの DM は無視する", async () => {
		gateway.setAllowedDirectMessageUserIds(["111"]);
		const captured: IncomingMessage[] = [];
		gateway.onDirectMessage(async (msg) => {
			captured.push(msg);
		});

		await gateway.start();
		mockSetup.emit(Events.MessageCreate, createDmMessage({ authorId: "222" }));
		await Bun.sleep(50);

		expect(captured).toHaveLength(0);
	});

	it("bot 自身の許可済み DM 送信イベントは記録用に directMessageHandler へ流す", async () => {
		gateway.setAllowedDirectMessageUserIds(["111"]);
		const captured: IncomingMessage[] = [];
		gateway.onDirectMessage(async (msg) => {
			captured.push(msg);
		});

		await gateway.start();
		mockSetup.emit(
			Events.MessageCreate,
			createDmMessage({
				authorId: "bot-user-id",
				authorBot: true,
				recipientId: "111",
				content: "bot reply",
			}),
		);
		await Bun.sleep(50);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.authorId).toBe("bot-user-id");
		expect(captured[0]?.scopeId).toBe(discordDmScopeId("111"));
		expect(captured[0]?.isMentioned).toBe(false);
	});
});
