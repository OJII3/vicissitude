/**
 * セッションエラー検知改善: session.error のログレベル修正の仕様テスト
 *
 * 期待仕様:
 * 1. promptAsyncAndWatchSession で classifyEvent が error を返した場合、error レベルでログ出力する
 * 2. waitForSessionIdle で classifyEvent が error を返した場合、error レベルでログ出力する
 * 3. エラーログにエラー詳細（message）が含まれる
 */
import { describe, expect, mock, test } from "bun:test";

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";
import type { Logger } from "@vicissitude/shared/types";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";

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

/** logger のスパイを返すアダプターファクトリ */
function createAdapterWithLoggerSpy(client: OpencodeClient) {
	const loggerSpy = {
		debug: mock(() => {}),
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		child() { return loggerSpy as Logger; },
	};
	const adapter = new OpencodeSessionAdapter({
		port: 4096,
		mcpServers: {},
		builtinTools: {},
		logger: loggerSpy,
		clientFactory: mock(() =>
			Promise.resolve({
				client,
				server: { url: "http://localhost", close: mock(() => {}) },
			}),
		),
	});
	return { adapter, loggerSpy };
}

function makeSessionErrorEvent(sessionId: string): Event {
	return {
		type: "session.error",
		properties: { sessionID: sessionId, code: "INTERNAL" },
	} as unknown as Event;
}

// ─── promptAsyncAndWatchSession ──────────────────────────────────

describe("promptAsyncAndWatchSession: session.error のログレベル", () => {
	test("session.error イベントを受信した場合、error レベルでログ出力する", async () => {
		let callCount = 0;
		const stream = {
			next: mock(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve<IteratorResult<Event, void>>({
						done: false,
						value: makeSessionErrorEvent("session-1"),
					});
				}
				return new Promise<IteratorResult<Event, void>>(() => {});
			}),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;

		const client = createClient(stream);
		const { adapter, loggerSpy } = createAdapterWithLoggerSpy(client);

		const result = await adapter.promptAsyncAndWatchSession({
			sessionId: "session-1",
			text: "hello",
			model: { providerId: "provider", modelId: "model" },
		});

		expect(result.type).toBe("error");
		// error レベルで出力されること（info ではない）
		const errorCalls = loggerSpy.error.mock.calls;
		expect(errorCalls.length).toBeGreaterThanOrEqual(1);
		// エラー詳細が含まれること
		const errorMessages = errorCalls.map((call) => JSON.stringify(call));
		const hasErrorDetail = errorMessages.some(
			(msg) => msg.includes("INTERNAL") || msg.includes("session.error"),
		);
		expect(hasErrorDetail).toBe(true);
	});
});

// ─── waitForSessionIdle ─────────────────────────────────────────

describe("waitForSessionIdle: session.error のログレベル", () => {
	test("session.error イベントを受信した場合、error レベルでログ出力する", async () => {
		let callCount = 0;
		const stream = {
			next: mock(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve<IteratorResult<Event, void>>({
						done: false,
						value: makeSessionErrorEvent("session-1"),
					});
				}
				return new Promise<IteratorResult<Event, void>>(() => {});
			}),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;

		const client = createClient(stream);
		const { adapter, loggerSpy } = createAdapterWithLoggerSpy(client);

		const result = await adapter.waitForSessionIdle("session-1");

		expect(result.type).toBe("error");
		// error レベルで出力されること
		const errorCalls = loggerSpy.error.mock.calls;
		expect(errorCalls.length).toBeGreaterThanOrEqual(1);
		// エラー詳細が含まれること
		const errorMessages = errorCalls.map((call) => JSON.stringify(call));
		const hasErrorDetail = errorMessages.some(
			(msg) => msg.includes("INTERNAL") || msg.includes("session.error"),
		);
		expect(hasErrorDetail).toBe(true);
	});
});
