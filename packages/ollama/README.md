# @vicissitude/ollama

Ollama HTTP API を Vicissitude の LLM / embedding ポートから使うための小さな adapter package。

## Public API

```ts
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { OllamaChatAdapter } from "@vicissitude/ollama/ollama-chat-adapter";
```

- `new OllamaEmbeddingAdapter(baseUrl, model, options?)`
- `new OllamaChatAdapter(baseUrl, model, logger?, options?)`

`options`:

```ts
type OllamaAdapterOptions = {
	http?: {
		fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
		createTimeoutSignal(timeoutMs: number): AbortSignal;
	};
	timeoutMs?: number;
};
```

`http` を省略した場合は runtime の `globalThis.fetch` と `AbortSignal.timeout` を使う。

## Endpoints

- `OllamaEmbeddingAdapter.embed(text)` は `POST /api/embed` に `{ model, input: text }` を送る。
- `OllamaChatAdapter.prompt(text)` は `POST /api/generate` に `{ model, prompt: text, stream: false }` を送る。

`baseUrl` の末尾 slash の有無にかかわらず、上記 path に正規化する。

## Errors

- HTTP `ok: false` は `Error` として扱い、Ollama の endpoint 名、status code、status text を message に含める。
- `/api/embed` の JSON は `embeddings[0]` が非空の `number[]` の場合だけ成功とする。それ以外は `TypeError` を投げる。
- `/api/generate` の JSON は `response` が `string` の場合だけ成功とする。それ以外は `TypeError` を投げる。

## Timeout

既定 timeout は `30_000ms`。`options.timeoutMs` で adapter ごとに変更できる。

timeout signal の作成は `http.createTimeoutSignal(timeoutMs)` に集約しているため、テストや別 runtime では `fetch` と同じ依存として差し替えられる。

## Logging

`OllamaChatAdapter` は `logger` が渡された場合だけ `debug` に以下を記録する。

- 送信時: `"[ollama] llm_request"` と `{ model, prompt }`
- 受信時: `"[ollama] llm_response"` と `{ model, text }`

`logger` 未指定時はログを出さない。`OllamaEmbeddingAdapter` はログを出さない。
