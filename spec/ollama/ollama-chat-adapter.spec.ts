import { afterEach, describe, expect, it } from "bun:test";
/**
 * OllamaChatAdapter 仕様テスト
 *
 * OllamaChatAdapter は Ollama /api/generate エンドポイントを叩く軽量アダプタで、
 * LlmPromptPort を実装する。EmotionEstimator の DI 配線に使用される。
 */

// NOTE: OllamaChatAdapter はまだ実装されていないため、
// パッケージエクスポートが追加され次第インポートパスを更新する。
// 現時点では直接ファイルパスでインポートする想定。
import { OllamaChatAdapter } from "@vicissitude/ollama/ollama-chat-adapter";

function mockFetch(response: { ok: boolean; status?: number; statusText?: string; body: unknown }) {
	globalThis.fetch = (() =>
		Promise.resolve({
			ok: response.ok,
			status: response.status ?? (response.ok ? 200 : 500),
			statusText: response.statusText ?? (response.ok ? "OK" : "Internal Server Error"),
			json: () => Promise.resolve(response.body),
		} as Response)) as unknown as typeof fetch;
}

describe("OllamaChatAdapter", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("正常レスポンスの response フィールドを返す", async () => {
		mockFetch({ ok: true, body: { response: "感情分析結果: positive" } });

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");
		const result = await adapter.prompt("テスト入力");

		expect(result).toBe("感情分析結果: positive");
	});

	it("/api/generate に正しいリクエストボディで POST する", async () => {
		let capturedUrl: string | URL = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = input as string | URL;
			capturedInit = init;
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve({ response: "ok" }),
			} as Response);
		}) as typeof fetch;

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");
		await adapter.prompt("分析してください");

		expect(capturedUrl.toString()).toBe("http://localhost:11434/api/generate");
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(capturedInit?.body as string)).toEqual({
			model: "gemma3",
			prompt: "分析してください",
			stream: false,
		});
	});

	it("HTTP エラー時にエラーをスローする", async () => {
		mockFetch({ ok: false, status: 503, statusText: "Service Unavailable", body: {} });

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");

		await expect(adapter.prompt("hello")).rejects.toThrow(/503/);
	});

	it("レスポンスに response フィールドがない場合にエラーをスローする", async () => {
		mockFetch({ ok: true, body: {} });

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");

		await expect(adapter.prompt("hello")).rejects.toThrow();
	});
});
