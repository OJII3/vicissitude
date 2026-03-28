import { afterEach, describe, expect, it } from "bun:test";

import { OllamaChatAdapter } from "./ollama-chat-adapter";

function captureFetch() {
	let capturedUrl: URL | string = "";
	let capturedInit: RequestInit | undefined;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		capturedUrl = input as URL | string;
		capturedInit = init;
		return Promise.resolve({
			ok: true,
			status: 200,
			statusText: "OK",
			json: () => Promise.resolve({ response: "ok" }),
		} as Response);
	}) as typeof fetch;
	return { url: () => capturedUrl, init: () => capturedInit };
}

describe("OllamaChatAdapter internals", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("AbortSignal.timeout(30_000) をリクエストに設定する", async () => {
		const captured = captureFetch();
		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");
		await adapter.prompt("test");

		const signal = captured.init()?.signal;
		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("baseUrl に末尾スラッシュがあっても正しい URL を構築する", async () => {
		const captured = captureFetch();
		const adapter = new OllamaChatAdapter("http://localhost:11434/", "gemma3");
		await adapter.prompt("test");

		expect(captured.url().toString()).toBe("http://localhost:11434/api/generate");
	});

	it("stream: false をリクエストボディに含める", async () => {
		const captured = captureFetch();
		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");
		await adapter.prompt("test");

		const body = JSON.parse(captured.init()?.body as string);
		expect(body.stream).toBe(false);
	});

	it("空文字列の response を正常に返す", async () => {
		globalThis.fetch = (() =>
			Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve({ response: "" }),
			} as Response)) as unknown as typeof fetch;

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");
		const result = await adapter.prompt("test");
		expect(result).toBe("");
	});

	it("response が null の場合 TypeError をスローする", async () => {
		globalThis.fetch = (() =>
			Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve({ response: null }),
			} as Response)) as unknown as typeof fetch;

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");
		await expect(adapter.prompt("test")).rejects.toBeInstanceOf(TypeError);
	});

	it("response が数値の場合 TypeError をスローする", async () => {
		globalThis.fetch = (() =>
			Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve({ response: 42 }),
			} as Response)) as unknown as typeof fetch;

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");
		await expect(adapter.prompt("test")).rejects.toBeInstanceOf(TypeError);
		await expect(adapter.prompt("test")).rejects.toThrow("no response field");
	});

	it("HTTP エラーメッセージにステータスコードとステータステキストを含む", async () => {
		globalThis.fetch = (() =>
			Promise.resolve({
				ok: false,
				status: 404,
				statusText: "Not Found",
				json: () => Promise.resolve({}),
			} as Response)) as unknown as typeof fetch;

		const adapter = new OllamaChatAdapter("http://localhost:11434", "gemma3");
		await expect(adapter.prompt("test")).rejects.toThrow("404 Not Found");
	});

	it("コンストラクタで渡した model がリクエストボディに反映される", async () => {
		const captured = captureFetch();
		const adapter = new OllamaChatAdapter("http://localhost:11434", "llama3.2");
		await adapter.prompt("test");

		const body = JSON.parse(captured.init()?.body as string);
		expect(body.model).toBe("llama3.2");
	});
});
