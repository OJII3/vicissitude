export const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;

export interface OllamaHttpDependency {
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	createTimeoutSignal(timeoutMs: number): AbortSignal;
}

export interface OllamaAdapterOptions {
	http?: OllamaHttpDependency;
	timeoutMs?: number;
}

const defaultHttp: OllamaHttpDependency = {
	fetch: (input, init) => globalThis.fetch(input, init),
	createTimeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
};

export function resolveOllamaAdapterOptions(options: OllamaAdapterOptions = {}) {
	return {
		http: options.http ?? defaultHttp,
		timeoutMs: options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
	};
}

export function postOllamaJson(
	http: OllamaHttpDependency,
	timeoutMs: number,
	url: URL,
	body: unknown,
): Promise<Response> {
	return http.fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: http.createTimeoutSignal(timeoutMs),
	});
}
