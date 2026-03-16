/** Ollama HTTP API embedding adapter */
export class OllamaEmbeddingAdapter {
	constructor(
		private readonly baseUrl: string,
		private readonly model: string,
	) {}

	async embed(text: string): Promise<number[]> {
		const url = new URL("/api/embed", this.baseUrl);
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: this.model, input: text }),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as { embeddings: number[][] };
		const embedding = data.embeddings[0];
		if (!embedding) {
			throw new Error("Ollama embed returned no embeddings");
		}
		return embedding;
	}
}
