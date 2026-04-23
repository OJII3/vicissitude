/* oxlint-disable require-await, no-constructor-return, typescript/no-floating-promises -- テスト用モック */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { IncomingMessage, Logger } from "@vicissitude/shared/types";
import { Collection, Events } from "discord.js";

import { DiscordGateway } from "../../../apps/discord/src/gateway/discord";

// ─── Helpers ─────────────────────────────────────────────────────

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

/**
 * メンション置換テスト用のメッセージを作成するヘルパー。
 * mentions.members / mentions.users を細かく制御できる。
 */
function createMockMessageWithMentions(opts: {
	content: string;
	members?: Map<string, { displayName: string }>;
	users?: Map<string, { displayName: string }>;
}) {
	const members = opts.members;
	const users = opts.users ?? new Map();

	return {
		id: `msg-${Math.random().toString(36).slice(2, 8)}`,
		author: {
			id: "user-author",
			username: "testuser",
			displayName: "Test User",
			bot: false,
		},
		member: { displayName: "Test User" },
		channel: {
			id: "home-channel",
			name: "test-channel",
			isThread: () => false,
			parentId: null,
			sendTyping: mock(async () => {}),
			send: mock(async () => {}),
		},
		guildId: "guild-1",
		content: opts.content,
		mentions: {
			has: () => false,
			members: members
				? {
						get: (id: string): { displayName: string } | null =>
							(members.get(id) as { displayName: string } | undefined) ?? null,
					}
				: null,
			users: {
				get: (id: string): { displayName: string } | null =>
					(users.get(id) as { displayName: string } | undefined) ?? null,
			},
		},
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

// ─── Client コンストラクタをモックで差し替える ───────────────────

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

// ─── Tests ───────────────────────────────────────────────────────

describe("DiscordGateway - メンション置換", () => {
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

	/** ホームチャンネル経由でメッセージを送信し、受信した IncomingMessage を返す */
	async function sendAndCapture(
		message: ReturnType<typeof createMockMessageWithMentions>,
	): Promise<IncomingMessage> {
		const channelId = message.channel.id;
		gateway.setHomeChannelIds([channelId]);

		const captured: IncomingMessage[] = [];
		gateway.onHomeChannelMessage(async (msg) => {
			captured.push(msg);
		});

		await gateway.start();
		mockSetup.emit(Events.MessageCreate, message);

		await new Promise<void>((resolve) => {
			setTimeout(resolve, 50);
		});

		expect(captured).toHaveLength(1);
		const result = captured[0];
		if (!result) throw new Error("captured message is undefined");
		return result;
	}

	it("メンションが members の displayName に置き換わる", async () => {
		const members = new Map([["123456", { displayName: "Alice" }]]);
		const message = createMockMessageWithMentions({
			content: "こんにちは <@123456> さん",
			members,
		});

		const result = await sendAndCapture(message);

		expect(result.content).toBe("こんにちは @Alice さん");
	});

	it("members が取得できない場合に users の displayName にフォールバックする", async () => {
		const users = new Map([["789012", { displayName: "Bob" }]]);
		const message = createMockMessageWithMentions({
			content: "おはよう <@789012>",
			// members は null（DM などギルド外コンテキスト）
			members: undefined,
			users,
		});

		const result = await sendAndCapture(message);

		expect(result.content).toBe("おはよう @Bob");
	});

	it("members に該当ユーザーがいない場合に users にフォールバックする", async () => {
		// 空の Map（members にユーザーが含まれていないケース）
		const members = new Map<string, { displayName: string }>();
		const users = new Map([["345678", { displayName: "Charlie" }]]);
		const message = createMockMessageWithMentions({
			content: "<@345678> こんばんは",
			members,
			users,
		});

		const result = await sendAndCapture(message);

		expect(result.content).toBe("@Charlie こんばんは");
	});

	it("members にも users にも該当ユーザーがいない場合、元テキストを維持する", async () => {
		const message = createMockMessageWithMentions({
			content: "誰だ <@999999> は",
		});

		const result = await sendAndCapture(message);

		expect(result.content).toBe("誰だ <@999999> は");
	});

	it("複数メンションをそれぞれ正しく置換する", async () => {
		const members = new Map([
			["111", { displayName: "Alice" }],
			["222", { displayName: "Bob" }],
		]);
		const message = createMockMessageWithMentions({
			content: "<@111> と <@222> がいます",
			members,
		});

		const result = await sendAndCapture(message);

		expect(result.content).toBe("@Alice と @Bob がいます");
	});

	it("メンションなしのメッセージは変更されない", async () => {
		const message = createMockMessageWithMentions({
			content: "メンションのない普通のメッセージ",
		});

		const result = await sendAndCapture(message);

		expect(result.content).toBe("メンションのない普通のメッセージ");
	});

	it("ニックバンパターン <@!ID> も正しく置換される", async () => {
		const members = new Map([["456789", { displayName: "Diana" }]]);
		const message = createMockMessageWithMentions({
			content: "やあ <@!456789>",
			members,
		});

		const result = await sendAndCapture(message);

		expect(result.content).toBe("やあ @Diana");
	});
});
