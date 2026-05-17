import {
	postOllamaJson,
	resolveOllamaAdapterOptions,
	type OllamaAdapterOptions,
	type OllamaHttpDependency,
} from "./ollama-http";

export type { OllamaAdapterOptions, OllamaHttpDependency } from "./ollama-http";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function assertEmbeddingResponse(data: unknown): number[] {
	if (!isRecord(data) || !Array.isArray(data.embeddings)) {
		throw new TypeError(
			"Ollama embed returned invalid response: expected embeddings[0] to be a non-empty number[]",
		);
	}

	const embedding: unknown = data.embeddings[0];
	if (!Array.isArray(embedding)) {
		throw new TypeError(
			"Ollama embed returned invalid response: expected embeddings[0] to be a non-empty number[]",
		);
	}

	const values: unknown[] = embedding;
	if (values.length === 0 || !values.every((value): value is number => isFiniteNumber(value))) {
		throw new TypeError(
			"Ollama embed returned invalid response: expected embeddings[0] to be a non-empty number[]",
		);
	}

	return values;
}

/** Ollama HTTP API embedding adapter */
export class OllamaEmbeddingAdapter {
	private readonly http: OllamaHttpDependency;
	private readonly timeoutMs: number;

	constructor(
		private readonly baseUrl: string,
		private readonly model: string,
		options: OllamaAdapterOptions = {},
	) {
		const resolvedOptions = resolveOllamaAdapterOptions(options);
		this.http = resolvedOptions.http;
		this.timeoutMs = resolvedOptions.timeoutMs;
	}

	async embed(text: string): Promise<number[]> {
		const url = new URL("/api/embed", this.baseUrl);
		const response = await postOllamaJson(this.http, this.timeoutMs, url, {
			model: this.model,
			input: text,
		});

		if (!response.ok) {
			throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
		}

		return assertEmbeddingResponse(await response.json());
	}
}
