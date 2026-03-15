import { afterEach, describe, expect, it } from "bun:test";

import { OllamaEmbeddingAdapter } from "../../src/ollama/ollama-embedding-adapter.ts";

function mockFetch(response: { ok: boolean; status?: number; statusText?: string; body: unknown }) {
	globalThis.fetch = (() =>
		Promise.resolve({
			ok: response.ok,
			status: response.status ?? (response.ok ? 200 : 500),
			statusText: response.statusText ?? (response.ok ? "OK" : "Internal Server Error"),
			json: () => Promise.resolve(response.body),
		} as Response)) as unknown as typeof fetch;
}

describe("OllamaEmbeddingAdapter", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("should return embedding vector on success", async () => {
		const embedding = [0.1, 0.2, 0.3, 0.4];
		mockFetch({ ok: true, body: { embeddings: [embedding] } });

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text");
		const result = await adapter.embed("hello world");

		expect(result).toEqual(embedding);
	});

	it("should call correct URL with correct body", async () => {
		let capturedUrl: string | URL = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = input as string | URL;
			capturedInit = init;
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve({ embeddings: [[1.0]] }),
			} as Response);
		}) as typeof fetch;

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text");
		await adapter.embed("test input");

		expect(capturedUrl.toString()).toBe("http://localhost:11434/api/embed");
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(capturedInit?.body as string)).toEqual({
			model: "nomic-embed-text",
			input: "test input",
		});
	});

	it("should throw on HTTP error", async () => {
		mockFetch({ ok: false, status: 503, statusText: "Service Unavailable", body: {} });

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text");

		await expect(adapter.embed("hello")).rejects.toThrow(
			"Ollama embed failed: 503 Service Unavailable",
		);
	});

	it("should throw when embeddings array is empty", async () => {
		mockFetch({ ok: true, body: { embeddings: [] } });

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text");

		await expect(adapter.embed("hello")).rejects.toThrow("Ollama embed returned no embeddings");
	});
});
