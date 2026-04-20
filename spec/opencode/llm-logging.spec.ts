/**
 * OpencodeSessionAdapter LLM プロンプト/出力のログ記録 仕様テスト
 *
 * 期待仕様:
 * 1. prompt() でリクエスト送信時に debug ログでプロンプト内容を記録する
 * 2. prompt() でレスポンス受信時に debug ログで出力内容を記録する
 * 3. debug ログにモデル情報が含まれる
 * 4. Logger が未設定の場合にエラーにならない
 */
import { describe, expect, mock, test } from "bun:test";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import { createMockLogger } from "@vicissitude/shared/test-helpers";

// --- テストヘルパー ---

function createMockClient() {
	return {
		event: {
			subscribe: mock(() =>
				Promise.resolve({
					stream: {
						next: mock(() => new Promise<IteratorResult<never, void>>(() => {})),
						return: mock(() => Promise.resolve({ done: true, value: undefined })),
						[Symbol.asyncIterator]() {
							return this;
						},
					},
				}),
			),
		},
		session: {
			create: mock(() => Promise.resolve({ data: { id: "session-1" }, error: null })),
			get: mock(() => Promise.resolve({ data: { id: "session-1" }, error: null })),
			prompt: mock(() =>
				Promise.resolve({
					data: {
						parts: [{ type: "text", text: "LLM応答テキスト" }],
						info: {},
					},
					error: null,
				}),
			),
			promptAsync: mock(() => Promise.resolve({ data: {}, error: null })),
			abort: mock(() => Promise.resolve({ data: {}, error: null })),
			delete: mock(() => Promise.resolve({ data: {}, error: null })),
		},
	} as unknown as OpencodeClient;
}

function createAdapter(opts: { logger?: ReturnType<typeof createMockLogger> } = {}) {
	const logger = opts.logger ?? createMockLogger();
	const client = createMockClient();
	const adapter = new OpencodeSessionAdapter({
		port: 4096,
		mcpServers: {},
		builtinTools: {},
		logger,
		clientFactory: mock(() =>
			Promise.resolve({
				client,
				server: { url: "http://localhost", close: mock(() => {}) },
			}),
		),
	});
	return { adapter, logger, client };
}

const promptParams = {
	sessionId: "session-1",
	text: "ユーザーからのプロンプト",
	model: { providerId: "test-provider", modelId: "test-model" },
};

// --- prompt() のログ記録 ---

describe("OpencodeSessionAdapter prompt() LLM ログ記録", () => {
	test("リクエスト送信時にプロンプト内容を debug ログで記録する", async () => {
		const { adapter, logger } = createAdapter();

		await adapter.prompt(promptParams);

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasPromptLog = allArgs.some((arg: string) => arg.includes("ユーザーからのプロンプト"));
		expect(hasPromptLog).toBe(true);
	});

	test("レスポンス受信時に出力内容を debug ログで記録する", async () => {
		const { adapter, logger } = createAdapter();

		await adapter.prompt(promptParams);

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasResponseLog = allArgs.some((arg: string) => arg.includes("LLM応答テキスト"));
		expect(hasResponseLog).toBe(true);
	});

	test("debug ログにモデル情報が含まれる", async () => {
		const { adapter, logger } = createAdapter();

		await adapter.prompt(promptParams);

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasModel = allArgs.some(
			(arg: string) => arg.includes("test-provider") || arg.includes("test-model"),
		);
		expect(hasModel).toBe(true);
	});

	test("Logger 未設定でもエラーにならない", async () => {
		const client = createMockClient();
		const adapter = new OpencodeSessionAdapter({
			port: 4096,
			mcpServers: {},
			builtinTools: {},
			// logger を渡さない
			clientFactory: mock(() =>
				Promise.resolve({
					client,
					server: { url: "http://localhost", close: mock(() => {}) },
				}),
			),
		});

		const result = await adapter.prompt(promptParams);
		expect(result.text).toBe("LLM応答テキスト");
	});
});
