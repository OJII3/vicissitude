/**
 * MemoryChatAdapter LLM プロンプト/出力のログ記録 仕様テスト
 *
 * 期待仕様:
 * 1. chat() でリクエスト送信時に debug ログでプロンプト内容を記録する
 * 2. chat() でレスポンス受信時に debug ログで出力内容を記録する
 * 3. debug ログにモデル情報が含まれる
 */
import { describe, expect, it, mock } from "bun:test";

import { MemoryChatAdapter } from "@vicissitude/memory/chat-adapter";
import type { ChatMessage } from "@vicissitude/memory/types";
import { createMockLogger } from "@vicissitude/shared/test-helpers";
import type { OpencodeSessionPort } from "@vicissitude/shared/types";

// --- テストヘルパー ---

function createMockSessionPort(responseText: string): OpencodeSessionPort {
	return {
		createSession: mock(() => Promise.resolve("test-session-id")),
		sessionExists: mock(() => Promise.resolve(true)),
		prompt: mock(() => Promise.resolve({ text: responseText })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() =>
			Promise.resolve({ type: "idle" as const, messages: [] }),
		),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const, messages: [] })),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort;
}

const testMessages: ChatMessage[] = [
	{ role: "system", content: "あなたはアシスタントです" },
	{ role: "user", content: "ユーザーからの質問内容" },
];

describe("MemoryChatAdapter chat() LLM ログ記録", () => {
	it("リクエスト送信時にプロンプト内容を debug ログで記録する", async () => {
		const logger = createMockLogger();
		const port = createMockSessionPort("応答テキスト");
		const adapter = new MemoryChatAdapter(port, "test-provider", "test-model", logger);

		await adapter.chat(testMessages);

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasPromptLog = allArgs.some((arg: string) => arg.includes("ユーザーからの質問内容"));
		expect(hasPromptLog).toBe(true);
	});

	it("レスポンス受信時に出力内容を debug ログで記録する", async () => {
		const logger = createMockLogger();
		const port = createMockSessionPort("LLMからの応答テキスト");
		const adapter = new MemoryChatAdapter(port, "test-provider", "test-model", logger);

		await adapter.chat(testMessages);

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasResponseLog = allArgs.some((arg: string) => arg.includes("LLMからの応答テキスト"));
		expect(hasResponseLog).toBe(true);
	});

	it("debug ログにモデル情報が含まれる", async () => {
		const logger = createMockLogger();
		const port = createMockSessionPort("ok");
		const adapter = new MemoryChatAdapter(port, "test-provider", "test-model", logger);

		await adapter.chat(testMessages);

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasModel = allArgs.some(
			(arg: string) => arg.includes("test-provider") || arg.includes("test-model"),
		);
		expect(hasModel).toBe(true);
	});
});
