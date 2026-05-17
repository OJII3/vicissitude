import {
	postOllamaJson,
	resolveOllamaAdapterOptions,
	type OllamaAdapterOptions,
	type OllamaHttpDependency,
} from "./ollama-http";

export type { OllamaAdapterOptions, OllamaHttpDependency } from "./ollama-http";

/** ollama パッケージは外部 workspace に依存できないため、必要最小限のログインターフェースをローカル定義 */
interface OllamaLogger {
	debug(message: string, ...args: unknown[]): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Ollama HTTP API generate adapter */
export class OllamaChatAdapter {
	private readonly http: OllamaHttpDependency;
	private readonly timeoutMs: number;

	constructor(
		private readonly baseUrl: string,
		private readonly model: string,
		private readonly logger?: OllamaLogger,
		options: OllamaAdapterOptions = {},
	) {
		const resolvedOptions = resolveOllamaAdapterOptions(options);
		this.http = resolvedOptions.http;
		this.timeoutMs = resolvedOptions.timeoutMs;
	}

	async prompt(text: string): Promise<string> {
		this.logger?.debug("[ollama] llm_request", { model: this.model, prompt: text });
		const url = new URL("/api/generate", this.baseUrl);
		const response = await postOllamaJson(this.http, this.timeoutMs, url, {
			model: this.model,
			prompt: text,
			stream: false,
		});

		if (!response.ok) {
			throw new Error(`Ollama generate failed: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		if (!isRecord(data) || typeof data.response !== "string") {
			throw new TypeError("Ollama generate returned no response field");
		}
		this.logger?.debug("[ollama] llm_response", { model: this.model, text: data.response });
		return data.response;
	}
}
