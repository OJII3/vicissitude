/* oxlint-disable require-await, no-constructor-return, typescript/no-floating-promises -- テスト用モック */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { IncomingMessage } from "@vicissitude/shared/types";
import { Collection, Events } from "discord.js";

import { DiscordGateway } from "../../../apps/discord/src/gateway/discord";

// ─── Helpers ─────────────────────────────────────────────────────

/** discord.js の Client をモックし、イベントリスナーを手動で発火できるようにする */
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
			fetch: mock((id: string) => Promise.resolve(channelStore.get(id) ?? null)),
		},
	};

	function emit(event: string, ...args: unknown[]) {
		for (const cb of listeners.get(event) ?? []) {
			cb(...args);
		}
	}

	const channelStore = new Map<string, unknown>();
	function registerChannel(id: string, channel: unknown) {
		channelStore.set(id, channel);
	}

	return { mockClient, emit, registerChannel };
}

/** 通常チャンネルのメッセージを作成するヘルパー */
function createMockMessage(overrides: {
	channelId: string;
	authorId?: string;
	isThread?: boolean;
	parentId?: string | null;
	guildId?: string;
	content?: string;
}) {
	const isThread = overrides.isThread ?? false;
	return {
		id: `msg-${Math.random().toString(36).slice(2, 8)}`,
		author: {
			id: overrides.authorId ?? "user-123",
			username: "testuser",
			displayName: "Test User",
			bot: false,
		},
		member: { displayName: "Test User" },
		channel: {
			id: overrides.channelId,
			name: "test-channel",
			isThread: () => isThread,
			parentId: isThread ? (overrides.parentId ?? null) : null,
			sendTyping: mock(async () => {}),
			send: mock(async () => {}),
		},
		guildId: overrides.guildId ?? "guild-1",
		content: overrides.content ?? "hello",
		mentions: { has: () => false },
		createdAt: new Date(),
		attachments: new Collection(),
		react: mock(async () => {}),
		reply: mock(async () => {}),
	};
}

/** ホームスレッド用のモックチャンネル（join / setArchived を持つ） */
function createMockThreadChannel(
	id: string,
	opts: { archived?: boolean; parentId?: string | null } = {},
) {
	return {
		id,
		isThread: () => true,
		parentId: opts.parentId ?? null,
		archived: opts.archived ?? false,
		join: mock(async () => {}),
		setArchived: mock(async () => {}),
	};
}

function createSilentLogger() {
	return {
		info: () => {},
		error: () => {},
		warn: () => {},
	};
}

// ─── Client コンストラクタをモックで差し替える ───────────────────

let currentMockClient: ReturnType<typeof createMockClient>;

mock.module("discord.js", () => {
	// oxlint-disable-next-line typescript/no-require-imports
	const actual = require("discord.js");
	return {
		...actual,
		// oxlint-disable-next-line no-constructor-return, typescript/no-extraneous-class
		Client: class MockedClient {
			constructor() {
				const { mockClient } = currentMockClient;
				return mockClient as unknown;
			}
		},
	};
});

// ─── Tests ───────────────────────────────────────────────────────

describe("DiscordGateway - ホームスレッド常駐", () => {
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

	// ─── 1. ホーム判定 ───────────────────────────────────────────

	describe("ホーム判定: スレッドIDが直接登録されている場合", () => {
		it("スレッドIDが homeChannelIds に含まれる場合、そのスレッドのメッセージはホーム扱いになる", async () => {
			const threadId = "thread-001";
			gateway.setHomeChannelIds([threadId]);

			const homeMessages: IncomingMessage[] = [];
			gateway.onHomeChannelMessage(async (msg) => {
				homeMessages.push(msg);
			});

			await gateway.start();

			const message = createMockMessage({
				channelId: threadId,
				isThread: true,
				parentId: "some-other-channel",
			});

			mockSetup.emit(Events.MessageCreate, message);

			// イベントハンドラは非同期なので少し待つ
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(homeMessages).toHaveLength(1);
			expect(homeMessages[0]?.channelId).toBe(threadId);
		});

		it("スレッドIDが homeChannelIds に含まれない場合、ホーム扱いにならない", async () => {
			gateway.setHomeChannelIds(["other-channel"]);

			const homeMessages: IncomingMessage[] = [];
			gateway.onHomeChannelMessage(async (msg) => {
				homeMessages.push(msg);
			});
			gateway.onMessage(async (msg) => {
				void msg;
			});

			await gateway.start();

			const message = createMockMessage({
				channelId: "thread-not-home",
				isThread: true,
				parentId: "unrelated-parent",
			});

			mockSetup.emit(Events.MessageCreate, message);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(homeMessages).toHaveLength(0);
		});
	});

	// ─── 2. 自動 join ───────────────────────────────────────────

	describe("自動 join: start() 後にホームスレッドへ join する", () => {
		it("homeChannelIds のうちスレッドであるものに join() が呼ばれる", async () => {
			const threadChannel = createMockThreadChannel("thread-home-1");
			mockSetup.registerChannel("thread-home-1", threadChannel);

			gateway.setHomeChannelIds(["thread-home-1", "normal-channel-1"]);
			await gateway.start();

			// start() 完了後、スレッドへの join が非同期で行われることを待つ
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			expect(threadChannel.join).toHaveBeenCalled();
		});

		it("通常チャンネル（スレッドでないもの）には join() を呼ばない", async () => {
			const normalChannel = {
				id: "normal-channel-1",
				isThread: () => false,
				join: mock(async () => {}),
			};
			mockSetup.registerChannel("normal-channel-1", normalChannel);

			const threadChannel = createMockThreadChannel("thread-home-1");
			mockSetup.registerChannel("thread-home-1", threadChannel);

			gateway.setHomeChannelIds(["normal-channel-1", "thread-home-1"]);
			await gateway.start();
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			expect(normalChannel.join).not.toHaveBeenCalled();
			expect(threadChannel.join).toHaveBeenCalled();
		});
	});

	// ─── 3. アーカイブ復帰 ──────────────────────────────────────

	describe("アーカイブ復帰: ホームスレッドがアーカイブされた場合に自動解除する", () => {
		it("ホームスレッドがアーカイブされたとき、setArchived(false) が呼ばれる", async () => {
			const threadId = "thread-home-1";
			gateway.setHomeChannelIds([threadId]);
			await gateway.start();

			const archivedThread = createMockThreadChannel(threadId, { archived: true });

			// ThreadUpdate イベントを発火（oldThread, newThread）
			mockSetup.emit(Events.ThreadUpdate, {}, archivedThread);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(archivedThread.setArchived).toHaveBeenCalledWith(false);
		});

		it("ホームスレッド以外がアーカイブされても setArchived は呼ばれない", async () => {
			gateway.setHomeChannelIds(["thread-home-1"]);
			await gateway.start();

			const otherThread = createMockThreadChannel("thread-other", { archived: true });

			mockSetup.emit(Events.ThreadUpdate, {}, otherThread);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(otherThread.setArchived).not.toHaveBeenCalled();
		});

		it("ホームスレッドがアーカイブ解除された場合（archived=false）は何もしない", async () => {
			const threadId = "thread-home-1";
			gateway.setHomeChannelIds([threadId]);
			await gateway.start();

			const unarchivedThread = createMockThreadChannel(threadId, { archived: false });

			mockSetup.emit(Events.ThreadUpdate, {}, unarchivedThread);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(unarchivedThread.setArchived).not.toHaveBeenCalled();
		});
	});

	// ─── 4. 既存動作の維持 ──────────────────────────────────────

	describe("既存動作の維持: ホームチャンネル配下スレッドのホーム判定", () => {
		it("ホームチャンネル配下のスレッドは引き続きホーム扱いになる", async () => {
			const parentChannelId = "home-channel-1";
			gateway.setHomeChannelIds([parentChannelId]);

			const homeMessages: IncomingMessage[] = [];
			gateway.onHomeChannelMessage(async (msg) => {
				homeMessages.push(msg);
			});

			await gateway.start();

			const message = createMockMessage({
				channelId: "child-thread-in-home",
				isThread: true,
				parentId: parentChannelId,
			});

			mockSetup.emit(Events.MessageCreate, message);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(homeMessages).toHaveLength(1);
		});

		it("ホームチャンネル自体のメッセージもホーム扱いになる", async () => {
			const channelId = "home-channel-1";
			gateway.setHomeChannelIds([channelId]);

			const homeMessages: IncomingMessage[] = [];
			gateway.onHomeChannelMessage(async (msg) => {
				homeMessages.push(msg);
			});

			await gateway.start();

			const message = createMockMessage({
				channelId,
				isThread: false,
			});

			mockSetup.emit(Events.MessageCreate, message);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(homeMessages).toHaveLength(1);
		});

		it("スレッドIDとチャンネルIDの両方を homeChannelIds に登録できる", async () => {
			const channelId = "home-channel-1";
			const threadId = "standalone-thread-1";
			gateway.setHomeChannelIds([channelId, threadId]);

			const homeMessages: IncomingMessage[] = [];
			gateway.onHomeChannelMessage(async (msg) => {
				homeMessages.push(msg);
			});

			await gateway.start();

			// チャンネルからのメッセージ
			const channelMsg = createMockMessage({
				channelId,
				isThread: false,
			});
			mockSetup.emit(Events.MessageCreate, channelMsg);

			// スレッドからのメッセージ
			const threadMsg = createMockMessage({
				channelId: threadId,
				isThread: true,
				parentId: "unrelated-parent",
			});
			mockSetup.emit(Events.MessageCreate, threadMsg);

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(homeMessages).toHaveLength(2);
		});
	});
});
