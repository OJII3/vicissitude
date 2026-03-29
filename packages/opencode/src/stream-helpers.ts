import type {
	Event,
	EventMessageUpdated,
	OpencodeClient,
	Part,
} from "@opencode-ai/sdk/v2";
import { withTimeout } from "@vicissitude/shared/functions";
import type { OpencodeSessionEvent, TokenUsage } from "@vicissitude/shared/types";

export type AbortableAsyncStream<T> = AsyncIterator<T> & {
	return?: (value?: unknown) => Promise<IteratorResult<T>>;
};
const STREAM_RETURNED = Symbol("streamReturned"),
	STREAM_RETURN_PROMISE = Symbol("streamReturnPromise");
type StreamReadResult = { type: "event"; value: unknown } | { type: "done" } | { type: "aborted" };

/** signal なしの stream.next() に適用するタイムアウト（5分） */
const STREAM_NEXT_TIMEOUT_MS = 5 * 60 * 1000;

export async function nextStreamEvent(
	stream: AbortableAsyncStream<unknown>,
	signal: AbortSignal | undefined,
	onAbort: () => Promise<void>,
): Promise<StreamReadResult> {
	if (!signal) {
		const result = await withTimeout(
			stream.next(),
			STREAM_NEXT_TIMEOUT_MS,
			"stream.next() timed out after 5 minutes",
		);
		return result.done ? { type: "done" } : { type: "event", value: result.value };
	}
	return waitForNextStreamEvent(stream, signal, onAbort);
}
function waitForNextStreamEvent(
	stream: AbortableAsyncStream<unknown>,
	signal: AbortSignal,
	onAbort: () => Promise<void>,
): Promise<StreamReadResult> {
	return new Promise<StreamReadResult>((resolve, reject) => {
		let settled = false;
		const finish = (complete: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", handleAbort);
			complete();
		};
		const handleAbort = () => {
			finish(() => {
				void onAbort();
				void returnStreamOnce(stream).catch(() => {});
				resolve({ type: "aborted" });
			});
		};
		signal.addEventListener("abort", handleAbort, { once: true });
		if (signal.aborted) {
			handleAbort();
			return;
		}
		void (async () => {
			try {
				const result = await withTimeout(
					stream.next(),
					STREAM_NEXT_TIMEOUT_MS,
					"stream.next() timed out after 5 minutes",
				);
				finish(() =>
					resolve(result.done ? { type: "done" } : { type: "event", value: result.value }),
				);
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		})();
	});
}
export function returnStreamOnce(stream: AbortableAsyncStream<unknown>): Promise<void> {
	const managed = stream as AbortableAsyncStream<unknown> & {
		[STREAM_RETURNED]?: boolean;
		[STREAM_RETURN_PROMISE]?: Promise<unknown>;
	};
	if (managed[STREAM_RETURN_PROMISE]) return managed[STREAM_RETURN_PROMISE] as Promise<void>;
	if (managed[STREAM_RETURNED]) return Promise.resolve();
	managed[STREAM_RETURNED] = true;
	managed[STREAM_RETURN_PROMISE] = managed.return ? managed.return() : Promise.resolve();
	return managed[STREAM_RETURN_PROMISE] as Promise<void>;
}
export async function abortSession(oc: OpencodeClient, sessionId: string): Promise<void> {
	try {
		await oc.session.abort({ sessionID: sessionId });
	} catch {
		// 停止経路ではベストエフォート。unhandled rejection にはしない。
	}
}
export function classifyEvent(
	typed: Event,
	sessionId: string,
	tokensByMessage: Map<string, TokenUsage>,
): OpencodeSessionEvent | null {
	if (typed.type === "message.updated") {
		accumulateTokens(typed, sessionId, tokensByMessage);
		return null;
	}
	if (typed.type === "session.idle") {
		const idle = typed;
		if (idle.properties.sessionID === sessionId) {
			return { type: "idle", tokens: sumTokens(tokensByMessage) };
		}
	}
	if (typed.type === "session.compacted") {
		const compacted = typed;
		if (compacted.properties.sessionID === sessionId) return { type: "compacted" };
	}
	if (typed.type === "session.error") {
		const err = typed;
		if (err.properties.sessionID === sessionId) {
			return { type: "error", message: JSON.stringify(err.properties) };
		}
	}
	return null;
}
function accumulateTokens(
	typed: EventMessageUpdated,
	sessionId: string,
	tokensByMessage: Map<string, TokenUsage>,
): void {
	const info = typed.properties.info;
	if (info.role === "assistant" && info.sessionID === sessionId) {
		tokensByMessage.set(info.id, {
			input: info.tokens.input,
			output: info.tokens.output,
			cacheRead: info.tokens.cache?.read ?? 0,
		});
	}
}
export function extractText(parts: Part[]): string {
	return parts
		.filter((p): p is Part & { type: "text" } => p.type === "text")
		.map((p) => p.text)
		.join("");
}
export function extractTokens(info: {
	tokens?: { input: number; output: number; cache?: { read: number } };
}): TokenUsage | undefined {
	if (!info.tokens) return undefined;
	return {
		input: info.tokens.input,
		output: info.tokens.output,
		cacheRead: info.tokens.cache?.read ?? 0,
	};
}
export function sumTokens(tokensByMessage: Map<string, TokenUsage>): TokenUsage | undefined {
	if (tokensByMessage.size === 0) return undefined;
	let cacheRead = 0;
	let input = 0;
	let output = 0;
	for (const t of tokensByMessage.values()) {
		input += t.input;
		output += t.output;
		cacheRead += t.cacheRead;
	}
	return { input, output, cacheRead };
}
