/**
 * Issue #536: streamDisconnected 時にトークン情報が破棄されるバグの再現テスト
 *
 * 期待仕様:
 * 1. OpencodeSessionEvent の streamDisconnected 型に tokens?: TokenUsage がある
 * 2. promptAsyncAndWatchSession で SSE 切断時に蓄積済みトークンが返る
 * 3. waitForSessionIdle で SSE 切断時に蓄積済みトークンが返る
 */
import { describe, expect, mock, test } from "bun:test";

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import type { OpencodeSessionEvent, TokenUsage } from "@vicissitude/shared/types";

// ─── 型レベルテスト ──────────────────────────────────────────────

describe("OpencodeSessionEvent 型", () => {
	test("streamDisconnected は tokens?: TokenUsage フィールドを持つ", () => {
		// コンパイルが通ること自体が型レベルの検証
		const event: OpencodeSessionEvent = {
			type: "streamDisconnected",
			tokens: { input: 10, output: 20, cacheRead: 5 },
		};
		expect(event.type).toBe("streamDisconnected");
		expect(event.tokens).toEqual({ input: 10, output: 20, cacheRead: 5 });
	});

	test("streamDisconnected の tokens は省略可能", () => {
		const event: OpencodeSessionEvent = { type: "streamDisconnected" };
		expect(event.type).toBe("streamDisconnected");
		expect(event.tokens).toBeUndefined();
	});
});

// ─── テストヘルパー ──────────────────────────────────────────────

function createClient(stream: AsyncGenerator<Event, void, unknown>) {
	const client = {
		event: {
			subscribe: mock(() => Promise.resolve({ stream })),
		},
		session: {
			create: mock(() => Promise.resolve({ data: { id: "session-1" }, error: null })),
			get: mock(() => Promise.resolve({ data: null, error: { message: "missing" } })),
			prompt: mock(() => Promise.resolve({ data: { parts: [], info: {} }, error: null })),
			promptAsync: mock(() => Promise.resolve({ data: {}, error: null })),
			abort: mock(() => Promise.resolve({ data: {}, error: null })),
			delete: mock(() => Promise.resolve({ data: {}, error: null })),
		},
	};
	return client as unknown as OpencodeClient;
}

function createAdapter(client: OpencodeClient): OpencodeSessionAdapter {
	return new OpencodeSessionAdapter({
		port: 4096,
		mcpServers: {},
		builtinTools: {},
		clientFactory: mock(() =>
			Promise.resolve({
				client,
				server: { url: "http://localhost", close: mock(() => {}) },
			}),
		),
	});
}

function makeMessageUpdatedEvent(
	sessionId: string,
	messageId: string,
	tokens: { input: number; output: number; cache: { read: number } },
): Event {
	return {
		type: "message.updated",
		properties: {
			info: {
				role: "assistant",
				sessionID: sessionId,
				id: messageId,
				tokens,
			},
		},
	} as unknown as Event;
}

// ─── 振る舞いテスト ──────────────────────────────────────────────

describe("promptAsyncAndWatchSession: SSE 切断時のトークン保持", () => {
	test("複数メッセージのトークンが蓄積された後に SSE 切断すると streamDisconnected に合算トークンが含まれる", async () => {
		let callCount = 0;
		const tokenEvents = [
			makeMessageUpdatedEvent("session-1", "msg-1", {
				input: 100,
				output: 50,
				cache: { read: 10 },
			}),
			makeMessageUpdatedEvent("session-1", "msg-2", {
				input: 200,
				output: 80,
				cache: { read: 20 },
			}),
		];

		const stream = {
			next: mock(() => {
				if (callCount < tokenEvents.length) {
					// biome-ignore lint: test code - index is always valid
					const event = tokenEvents[callCount] as Event;
					callCount++;
					return Promise.resolve<IteratorResult<Event, void>>({
						done: false,
						value: event,
					});
				}
				// トークンイベント後にタイムアウトをシミュレート
				return new Promise<IteratorResult<Event, void>>((_resolve, reject) => {
					setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 10);
				});
			}),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;

		const client = createClient(stream);
		const adapter = createAdapter(client);

		const result = await adapter.promptAsyncAndWatchSession({
			sessionId: "session-1",
			text: "hello",
			model: { providerId: "provider", modelId: "model" },
		});

		expect(result.type).toBe("streamDisconnected");
		const tokens = (result as { type: "streamDisconnected"; tokens?: TokenUsage })
			.tokens as TokenUsage;
		expect(tokens).toBeDefined();
		expect(tokens.input).toBe(300);
		expect(tokens.output).toBe(130);
		expect(tokens.cacheRead).toBe(30);
	});

	test("stream.next() がタイムアウトで reject した場合に蓄積トークンが streamDisconnected に含まれる", async () => {
		let callCount = 0;
		const tokenEvents = [
			makeMessageUpdatedEvent("session-1", "msg-1", {
				input: 100,
				output: 50,
				cache: { read: 10 },
			}),
		];

		const stream = {
			next: mock(() => {
				if (callCount < tokenEvents.length) {
					// biome-ignore lint: test code - index is always valid
					const event = tokenEvents[callCount] as Event;
					callCount++;
					return Promise.resolve<IteratorResult<Event, void>>({
						done: false,
						value: event,
					});
				}
				// 2 回目以降はタイムアウトをシミュレート
				return new Promise<IteratorResult<Event, void>>((_resolve, reject) => {
					setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 10);
				});
			}),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;

		const client = createClient(stream);
		const adapter = createAdapter(client);

		const result = await adapter.promptAsyncAndWatchSession({
			sessionId: "session-1",
			text: "hello",
			model: { providerId: "provider", modelId: "model" },
		});

		expect(result.type).toBe("streamDisconnected");
		const tokens = (result as { type: "streamDisconnected"; tokens?: TokenUsage })
			.tokens as TokenUsage;
		expect(tokens).toBeDefined();
		expect(tokens.input).toBe(100);
		expect(tokens.output).toBe(50);
		expect(tokens.cacheRead).toBe(10);
	});
});

describe("waitForSessionIdle: SSE 切断時のトークン保持", () => {
	test("stream.next() がタイムアウトで reject した場合に蓄積トークンが streamDisconnected に含まれる", async () => {
		let callCount = 0;
		const tokenEvents = [
			makeMessageUpdatedEvent("session-1", "msg-1", {
				input: 150,
				output: 60,
				cache: { read: 15 },
			}),
		];

		const stream = {
			next: mock(() => {
				if (callCount < tokenEvents.length) {
					// biome-ignore lint: test code - index is always valid
					const event = tokenEvents[callCount] as Event;
					callCount++;
					return Promise.resolve<IteratorResult<Event, void>>({
						done: false,
						value: event,
					});
				}
				return new Promise<IteratorResult<Event, void>>((_resolve, reject) => {
					setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 10);
				});
			}),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;

		const client = createClient(stream);
		const adapter = createAdapter(client);

		const result = await adapter.waitForSessionIdle("session-1");

		expect(result.type).toBe("streamDisconnected");
		const tokens = (result as { type: "streamDisconnected"; tokens?: TokenUsage })
			.tokens as TokenUsage;
		expect(tokens).toBeDefined();
		expect(tokens.input).toBe(150);
		expect(tokens.output).toBe(60);
		expect(tokens.cacheRead).toBe(15);
	});

	test("トークン蓄積なしで SSE 切断した場合 tokens は undefined", async () => {
		const stream = {
			next: mock(
				() =>
					new Promise<IteratorResult<Event, void>>((_resolve, reject) => {
						setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 10);
					}),
			),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;

		const client = createClient(stream);
		const adapter = createAdapter(client);

		const result = await adapter.waitForSessionIdle("session-1");

		expect(result.type).toBe("streamDisconnected");
		// トークン蓄積がない場合は tokens が undefined であること
		const tokens = (result as { type: "streamDisconnected"; tokens?: TokenUsage }).tokens;
		expect(tokens).toBeUndefined();
	});
});
