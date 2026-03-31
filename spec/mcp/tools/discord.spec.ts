/* oxlint-disable no-non-null-assertion -- test assertions after length/null checks */
import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiscordTools } from "@vicissitude/mcp/tools/discord";
import type { DiscordDeps } from "@vicissitude/mcp/tools/discord";

// ─── Test Helpers ────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
type ToolResult = { content: Array<{ type: string; text: string }> };

/** registerDiscordTools で登録されたツールを name → handler のマップとして取得する */
function captureTools(
	deps: DiscordDeps,
	boundGuildId?: string,
): { tools: Map<string, ToolHandler>; cleanup: () => void } {
	const tools = new Map<string, ToolHandler>();

	const fakeServer = {
		registerTool(name: string, _schema: unknown, handler: ToolHandler) {
			tools.set(name, handler);
		},
	} as unknown as McpServer;

	const cleanup = registerDiscordTools(fakeServer, deps, boundGuildId);

	return { tools, cleanup };
}

/** send / reply / sendTyping / react / read_messages が成功する Discord Client スタブ */
function createDiscordClientStub(): DiscordDeps["discordClient"] {
	const sentMessage = {
		id: "sent-msg-1",
		reply: () => Promise.resolve({ id: "reply-msg-1" }),
		react: () => Promise.resolve(),
	};

	return {
		channels: {
			fetch: () =>
				Promise.resolve({
					isTextBased: () => true,
					send: () => Promise.resolve(sentMessage),
					sendTyping: () => Promise.resolve(),
					messages: {
						fetch: (idOrOptions: unknown) => {
							// messages.fetch({ limit }) はコレクションを返す
							if (typeof idOrOptions === "object" && idOrOptions !== null) {
								const fakeCollection = [
									{
										author: { tag: "user#1234" },
										content: "hello world",
										attachments: createFakeAttachments([]),
									},
								];
								return Promise.resolve(fakeCollection);
							}
							// messages.fetch(messageId) は単一メッセージを返す
							return Promise.resolve(sentMessage);
						},
					},
				}),
		},
		guilds: {
			fetch: () =>
				Promise.resolve({
					channels: {
						fetch: () => {
							const channels = [
								{ isTextBased: () => true, name: "general", id: "ch-1" },
								{ isTextBased: () => true, name: "random", id: "ch-2" },
								{ isTextBased: () => false, name: "voice", id: "ch-3" },
							];
							return Promise.resolve({
								filter: (fn: (c: (typeof channels)[number]) => boolean) => {
									const filtered = channels.filter((c) => fn(c));
									return {
										map: (mapFn: (c: (typeof channels)[number]) => unknown) =>
											filtered.map((c) => mapFn(c)),
									};
								},
							});
						},
					},
				}),
		},
	} as unknown as DiscordDeps["discordClient"];
}

/** sendTyping をサポートしないチャンネルを返すスタブ */
function createClientStubWithoutSendTyping(): DiscordDeps["discordClient"] {
	return {
		channels: {
			fetch: () =>
				Promise.resolve({
					isTextBased: () => true,
					send: () => Promise.resolve({ id: "msg-1" }),
					// sendTyping が存在しない
					messages: { fetch: () => Promise.resolve({ id: "msg-1" }) },
				}),
		},
	} as unknown as DiscordDeps["discordClient"];
}

/** 画像添付ありのメッセージを返すスタブ */
function createClientStubWithImageAttachments(): DiscordDeps["discordClient"] {
	return {
		channels: {
			fetch: () =>
				Promise.resolve({
					isTextBased: () => true,
					send: () => Promise.resolve({ id: "msg-1" }),
					messages: {
						fetch: (_opts: unknown) => {
							const msgs = [
								{
									author: { tag: "user#5678" },
									content: "写真だよ",
									attachments: createFakeAttachments([
										{ url: "https://cdn.example.com/img.png", contentType: "image/png" },
									]),
								},
							];
							return Promise.resolve(msgs);
						},
					},
				}),
		},
	} as unknown as DiscordDeps["discordClient"];
}

/** Discord.js Collection 風の attachments スタブ */
function createFakeAttachments(items: Array<{ url: string; contentType: string }>): unknown {
	return {
		filter: (fn: (a: { contentType: string }) => boolean) => {
			const filtered = items.filter((a) => fn(a));
			return {
				map: (mapFn: (a: { url: string }) => unknown) => filtered.map((a) => mapFn(a)),
			};
		},
	};
}

// ─── Tests ───────────────────────────────────────────────────────

describe("registerDiscordTools", () => {
	test("6つのツールが登録される", () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });

		const expectedTools = [
			"send_typing",
			"send_message",
			"reply",
			"add_reaction",
			"read_messages",
			"list_channels",
		];
		for (const name of expectedTools) {
			expect(tools.has(name)).toBe(true);
		}
		expect(tools.size).toBe(6);
	});

	test("戻り値はクリーンアップ関数である", () => {
		const { cleanup } = captureTools({ discordClient: createDiscordClientStub() });

		expect(typeof cleanup).toBe("function");
	});
});

describe("send_typing", () => {
	test("typing 開始メッセージを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const sendTyping = tools.get("send_typing")!;

		const result = (await sendTyping({ channel_id: "ch-1" })) as ToolResult;

		expect(result.content[0]!.text).toBe("Typing indicator started");
	});

	test("sendTyping 非対応チャンネルでは分岐メッセージを返す", async () => {
		const { tools } = captureTools({
			discordClient: createClientStubWithoutSendTyping(),
		});
		const sendTyping = tools.get("send_typing")!;

		const result = (await sendTyping({ channel_id: "ch-1" })) as ToolResult;

		expect(result.content[0]!.text).toBe("Channel does not support typing indicators");
	});
});

describe("send_message", () => {
	test("メッセージ送信成功時にメッセージID付きレスポンスを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const sendMessage = tools.get("send_message")!;

		const result = (await sendMessage({
			channel_id: "ch-1",
			content: "テスト",
		})) as ToolResult;

		expect(result.content[0]!.text).toBe("Sent message sent-msg-1");
	});

	test("不正な file_path でエラーになる", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const sendMessage = tools.get("send_message")!;

		let threw = false;
		try {
			await sendMessage({
				channel_id: "ch-1",
				content: "テスト",
				file_path: "/nonexistent/path/file.png",
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

describe("reply", () => {
	test("リプライ送信成功時にメッセージID付きレスポンスを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const reply = tools.get("reply")!;

		const result = (await reply({
			channel_id: "ch-1",
			message_id: "msg-1",
			content: "返信テスト",
		})) as ToolResult;

		expect(result.content[0]!.text).toBe("Replied with message reply-msg-1");
	});

	test("不正な file_path でエラーになる", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const reply = tools.get("reply")!;

		let threw = false;
		try {
			await reply({
				channel_id: "ch-1",
				message_id: "msg-1",
				content: "テスト",
				file_path: "/nonexistent/path/file.png",
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

describe("add_reaction", () => {
	test("リアクション追加成功時に絵文字付きレスポンスを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const addReaction = tools.get("add_reaction")!;

		const result = (await addReaction({
			channel_id: "ch-1",
			message_id: "msg-1",
			emoji: "👍",
		})) as ToolResult;

		expect(result.content[0]!.text).toBe("Reacted with 👍");
	});
});

describe("read_messages", () => {
	test("メッセージを [author.tag] content 形式でフォーマットする", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const readMessages = tools.get("read_messages")!;

		const result = (await readMessages({
			channel_id: "ch-1",
			limit: 10,
		})) as ToolResult;

		expect(result.content[0]!.text).toContain("[user#1234] hello world");
	});

	test("画像添付がある場合は [画像: url] を表示する", async () => {
		const { tools } = captureTools({
			discordClient: createClientStubWithImageAttachments(),
		});
		const readMessages = tools.get("read_messages")!;

		const result = (await readMessages({
			channel_id: "ch-1",
			limit: 10,
		})) as ToolResult;

		expect(result.content[0]!.text).toContain("[user#5678] 写真だよ");
		expect(result.content[0]!.text).toContain("[画像: https://cdn.example.com/img.png]");
	});
});

describe("list_channels", () => {
	test("テキストチャンネル一覧を name (id) 形式で返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const listChannels = tools.get("list_channels")!;

		const result = (await listChannels({ guild_id: "guild-1" })) as ToolResult;

		expect(result.content[0]!.text).toContain("general (ch-1)");
		expect(result.content[0]!.text).toContain("random (ch-2)");
		// voice チャンネルは含まれない
		expect(result.content[0]!.text).not.toContain("voice");
	});

	test("boundGuildId 使用時は guild_id を省略できる", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() }, "bound-guild-1");
		const listChannels = tools.get("list_channels")!;

		const result = (await listChannels({})) as ToolResult;

		expect(result.content[0]!.text).toContain("general (ch-1)");
	});

	test("boundGuildId なしで guild_id 未指定時はエラーメッセージを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const listChannels = tools.get("list_channels")!;

		const result = (await listChannels({})) as ToolResult;

		expect(result.content[0]!.text).toContain("guild_id");
	});
});
