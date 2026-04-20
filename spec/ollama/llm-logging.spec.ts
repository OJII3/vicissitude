/**
 * OllamaChatAdapter LLM プロンプト/出力のログ記録 仕様テスト
 *
 * 期待仕様:
 * 1. prompt() でリクエスト送信時に debug ログでプロンプト内容を記録する
 * 2. prompt() でレスポンス受信時に debug ログで出力内容を記録する
 * 3. debug ログにモデル情報が含まれる
 * 4. Logger が未設定（optional）の場合にエラーにならない
 */
import { afterEach, describe, expect, it, mock } from "bun:test";

import { OllamaChatAdapter } from "@vicissitude/ollama/ollama-chat-adapter";
import { createMockLogger } from "@vicissitude/shared/test-helpers";

// --- テストヘルパー ---

function mockFetch(responseBody: unknown) {
	globalThis.fetch = (() =>
		Promise.resolve({
			ok: true,
			status: 200,
			statusText: "OK",
			json: () => Promise.resolve(responseBody),
		} as Response)) as unknown as typeof fetch;
}

describe("OllamaChatAdapter prompt() LLM ログ記録", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("リクエスト送信時にプロンプト内容を debug ログで記録する", async () => {
		mockFetch({ response: "回答テキスト" });
		const logger = createMockLogger();
		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", logger);

		await adapter.prompt("テスト入力プロンプト");

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasPromptLog = allArgs.some((arg: string) => arg.includes("テスト入力プロンプト"));
		expect(hasPromptLog).toBe(true);
	});

	it("レスポンス受信時に出力内容を debug ログで記録する", async () => {
		mockFetch({ response: "Ollamaからの回答" });
		const logger = createMockLogger();
		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", logger);

		await adapter.prompt("入力");

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasResponseLog = allArgs.some((arg: string) => arg.includes("Ollamaからの回答"));
		expect(hasResponseLog).toBe(true);
	});

	it("debug ログにモデル情報が含まれる", async () => {
		mockFetch({ response: "ok" });
		const logger = createMockLogger();
		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", logger);

		await adapter.prompt("入力");

		const debugCalls = logger.debug.mock.calls;
		const allArgs = debugCalls.map((call: unknown[]) => JSON.stringify(call));
		const hasModel = allArgs.some((arg: string) => arg.includes("gemma3"));
		expect(hasModel).toBe(true);
	});

	it("Logger 未設定でもエラーにならない", async () => {
		mockFetch({ response: "回答テキスト" });
		// Logger を渡さずにインスタンス生成
		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");

		const result = await adapter.prompt("テスト");
		expect(result).toBe("回答テキスト");
	});
});
