/* oxlint-disable no-non-null-assertion -- test helpers */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiscordTools } from "@vicissitude/mcp/tools/discord";
import type { DiscordDeps } from "@vicissitude/mcp/tools/discord";

// ─── Types ───────────────────────────────────────────────────────

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
export type ToolResult = { content: Array<{ type: string; text: string }> };

// ─── captureTools ────────────────────────────────────────────────

/** registerDiscordTools で登録されたツールを name → handler のマップとして取得する */
export function captureTools(
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

// ─── Discord Client Stubs ────────────────────────────────────────

/** Discord.js Collection 風の attachments スタブ */
export function createFakeAttachments(items: Array<{ url: string; contentType: string }>): unknown {
	return {
		filter: (fn: (a: { contentType: string }) => boolean) => {
			const filtered = items.filter((a) => fn(a));
			return {
				map: (mapFn: (a: { url: string }) => unknown) => filtered.map((a) => mapFn(a)),
			};
		},
	};
}

/** send / reply / sendTyping / react / read_messages / list_channels が成功する Discord Client スタブ */
export function createDiscordClientStub(): DiscordDeps["discordClient"] {
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
export function createClientStubWithoutSendTyping(): DiscordDeps["discordClient"] {
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

/** react() が reject するスタブ（無効な絵文字等） */
export function createClientStubWithReactError(): DiscordDeps["discordClient"] {
	const error = new Error("Unknown Emoji");
	return {
		channels: {
			fetch: () =>
				Promise.resolve({
					isTextBased: () => true,
					send: () => Promise.resolve({ id: "msg-1" }),
					messages: {
						fetch: (idOrOptions: unknown) => {
							if (typeof idOrOptions === "object" && idOrOptions !== null) {
								return Promise.resolve([]);
							}
							return Promise.resolve({
								id: "msg-1",
								reply: () => Promise.resolve({ id: "reply-msg-1" }),
								react: () => Promise.reject(error),
							});
						},
					},
				}),
		},
	} as unknown as DiscordDeps["discordClient"];
}

/** 画像添付ありのメッセージを返すスタブ（1枚） */
export function createClientStubWithImageAttachments(): DiscordDeps["discordClient"] {
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

/** 複数画像添付ありのメッセージを返すスタブ */
export function createClientStubWithMultipleImageAttachments(): DiscordDeps["discordClient"] {
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
									author: { tag: "user#9999" },
									content: "複数画像だよ",
									attachments: createFakeAttachments([
										{ url: "https://cdn.example.com/img1.png", contentType: "image/png" },
										{ url: "https://cdn.example.com/img2.jpg", contentType: "image/jpeg" },
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
