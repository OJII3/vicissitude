/** ollama パッケージは外部 workspace に依存できないため、必要最小限のログインターフェースをローカル定義 */
interface OllamaLogger {
	debug(message: string, ...args: unknown[]): void;
}

/** Ollama HTTP API generate adapter */
export class OllamaChatAdapter {
	constructor(
		private readonly baseUrl: string,
		private readonly model: string,
		private readonly logger?: OllamaLogger,
	) {}

	async prompt(text: string): Promise<string> {
		this.logger?.debug("[ollama] llm_request", { model: this.model, prompt: text });
		const url = new URL("/api/generate", this.baseUrl);
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: this.model, prompt: text, stream: false }),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			throw new Error(`Ollama generate failed: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as { response?: string };
		if (typeof data.response !== "string") {
			throw new TypeError("Ollama generate returned no response field");
		}
		this.logger?.debug("[ollama] llm_response", { model: this.model, text: data.response });
		return data.response;
	}
}
