import { afterEach, describe, expect, it } from "bun:test";

import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";

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

function mockGlobalFetch(response: { ok: boolean; body: unknown }) {
	globalThis.fetch = (() =>
		Promise.resolve({
			ok: response.ok,
			status: response.ok ? 200 : 500,
			statusText: response.ok ? "OK" : "Internal Server Error",
			json: () => Promise.resolve(response.body),
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

describe("OllamaEmbeddingAdapter", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("should return embedding vector on success", async () => {
		const embedding = [0.1, 0.2, 0.3, 0.4];
		const { http } = createHttp({ ok: true, body: { embeddings: [embedding] } });

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text", {
			http,
		});
		const result = await adapter.embed("hello world");

		expect(result).toEqual(embedding);
	});

	it("should call correct URL with correct body", async () => {
		const { captured, http } = createHttp({ ok: true, body: { embeddings: [[1.0]] } });

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text", {
			http,
		});
		await adapter.embed("test input");

		expect(toUrlText(captured.url)).toBe("http://localhost:11434/api/embed");
		expect(captured.init?.method).toBe("POST");
		expect(captured.init?.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(captured.init?.body as string)).toEqual({
			model: "nomic-embed-text",
			input: "test input",
		});
	});

	it("should use injected HTTP dependency without replacing global fetch", async () => {
		mockGlobalFetch({ ok: true, body: { embeddings: [[999]] } });
		const { http } = createHttp({ ok: true, body: { embeddings: [[1.0, 2.0]] } });

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text", {
			http,
		});
		const result = await adapter.embed("hello");

		expect(result).toEqual([1.0, 2.0]);
	});

	it("should pass configured timeout to HTTP dependency", async () => {
		const { captured, http } = createHttp({ ok: true, body: { embeddings: [[1.0]] } });

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text", {
			http,
			timeoutMs: 12_345,
		});
		await adapter.embed("hello");

		expect(captured.timeoutMs).toBe(12_345);
		expect(captured.init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("should throw on HTTP error", async () => {
		const { http } = createHttp({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
			body: {},
		});

		const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text", {
			http,
		});

		const error = await captureError(() => adapter.embed("hello"));
		expect(String(error)).toContain("Ollama embed failed: 503 Service Unavailable");
	});

	const invalidEmbeddingResponses = [
		{ name: "missing embeddings", body: {} },
		{ name: "non-array embeddings", body: { embeddings: "not-array" } },
		{ name: "empty embeddings", body: { embeddings: [] } },
		{ name: "empty first embedding", body: { embeddings: [[]] } },
		{ name: "non-array first embedding", body: { embeddings: ["not-array"] } },
		{ name: "non-number value", body: { embeddings: [[1.0, "2.0"]] } },
		{ name: "non-finite number", body: { embeddings: [[1.0, Number.NaN]] } },
	];

	for (const invalidResponse of invalidEmbeddingResponses) {
		it(`should throw TypeError when embedding response is ${invalidResponse.name}`, async () => {
			const { http } = createHttp({ ok: true, body: invalidResponse.body });

			const adapter = new OllamaEmbeddingAdapter("http://localhost:11434", "nomic-embed-text", {
				http,
			});

			const error = await captureError(() => adapter.embed("hello"));
			expect(error).toBeInstanceOf(TypeError);
			expect(String(error)).toContain("non-empty number[]");
		});
	}
});
