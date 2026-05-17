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

type CapturedRequest = {
	init?: RequestInit;
	timeoutMs?: number;
	url?: string | URL | Request;
};

function createHttp(response: {
	ok: boolean;
	status?: number;
	statusText?: string;
	body: unknown;
}) {
	const captured: CapturedRequest = {};
	const timeoutSignal = AbortSignal.abort("test timeout");

	return {
		captured,
		http: {
			fetch: (input: string | URL | Request, init?: RequestInit) => {
				captured.url = input;
				captured.init = init;
				return Promise.resolve({
					ok: response.ok,
					status: response.status ?? (response.ok ? 200 : 500),
					statusText: response.statusText ?? (response.ok ? "OK" : "Internal Server Error"),
					json: () => Promise.resolve(response.body),
				} as Response);
			},
			createTimeoutSignal: (timeoutMs: number) => {
				captured.timeoutMs = timeoutMs;
				return timeoutSignal;
			},
		},
	};
}

function mockGlobalFetch(responseBody: unknown) {
	globalThis.fetch = (() =>
		Promise.resolve({
			ok: true,
			status: 200,
			statusText: "OK",
			json: () => Promise.resolve(responseBody),
		} as Response)) as unknown as typeof fetch;
}

function toUrlText(url: string | URL | Request | undefined): string {
	if (typeof url === "string") {
		return url;
	}
	if (url instanceof URL) {
		return url.href;
	}
	if (url instanceof Request) {
		return url.url;
	}
	throw new Error("Expected captured URL");
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected action to throw");
}

describe("OllamaChatAdapter", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("正常レスポンスの response フィールドを返す", async () => {
		const { http } = createHttp({ ok: true, body: { response: "感情分析結果: positive" } });

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", undefined, { http });
		const result = await adapter.prompt("テスト入力");

		expect(result).toBe("感情分析結果: positive");
	});

	it("/api/generate に正しいリクエストボディで POST する", async () => {
		const { captured, http } = createHttp({ ok: true, body: { response: "ok" } });

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", undefined, { http });
		await adapter.prompt("分析してください");

		expect(toUrlText(captured.url)).toBe("http://localhost:11434/api/generate");
		expect(captured.init?.method).toBe("POST");
		expect(captured.init?.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(captured.init?.body as string)).toEqual({
			model: "gemma3",
			prompt: "分析してください",
			stream: false,
		});
	});

	it("注入 HTTP 依存を使い、global fetch を差し替えなくても動作する", async () => {
		mockGlobalFetch({ response: "global" });
		const { http } = createHttp({ ok: true, body: { response: "injected" } });

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", undefined, { http });
		const result = await adapter.prompt("hello");

		expect(result).toBe("injected");
	});

	it("設定した timeout を HTTP 依存へ渡す", async () => {
		const { captured, http } = createHttp({ ok: true, body: { response: "ok" } });

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", undefined, {
			http,
			timeoutMs: 7_500,
		});
		await adapter.prompt("hello");

		expect(captured.timeoutMs).toBe(7_500);
		expect(captured.init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("HTTP エラー時にエラーをスローする", async () => {
		const { http } = createHttp({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
			body: {},
		});

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", undefined, { http });

		const error = await captureError(() => adapter.prompt("hello"));
		expect(String(error)).toContain("503");
	});

	it("レスポンスに response フィールドがない場合にエラーをスローする", async () => {
		const { http } = createHttp({ ok: true, body: {} });

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3", undefined, { http });

		const error = await captureError(() => adapter.prompt("hello"));
		expect(error).toBeInstanceOf(TypeError);
	});
});
