import type { Event, EventMessageUpdated, OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import { withTimeout } from "@vicissitude/shared/functions";
import type { Logger, OpencodeSessionEvent, TokenUsage } from "@vicissitude/shared/types";

export type AbortableAsyncStream<T> = AsyncIterator<T> & {
	return?: (value?: unknown) => Promise<IteratorResult<T>>;
};
const STREAM_RETURNED = Symbol("streamReturned"),
	STREAM_RETURN_PROMISE = Symbol("streamReturnPromise");
type StreamReadResult =
	| { type: "event"; value: unknown }
	| { type: "done" }
	| { type: "aborted" }
	| { type: "streamTimeout"; reason?: string }
	| { type: "streamError"; reason: string };

/** signal なしの stream.next() に適用するタイムアウト（5分） */
const STREAM_NEXT_TIMEOUT_MS = 5 * 60 * 1000;

function classifyStreamError(err: unknown): StreamReadResult {
	const reason = err instanceof Error ? err.message : String(err);
	if (reason.includes("timed out")) {
		return { type: "streamTimeout", reason };
	}
	return { type: "streamError", reason };
}

export async function nextStreamEvent(
	stream: AbortableAsyncStream<unknown>,
	signal: AbortSignal | undefined,
	onAbort: () => Promise<void>,
): Promise<StreamReadResult> {
	if (!signal) {
		try {
			const result = await withTimeout(
				stream.next(),
				STREAM_NEXT_TIMEOUT_MS,
				"stream.next() timed out after 5 minutes",
			);
			return result.done ? { type: "done" } : { type: "event", value: result.value };
		} catch (err) {
			return classifyStreamError(err);
		}
	}
	return waitForNextStreamEvent(stream, signal, onAbort);
}
function waitForNextStreamEvent(
	stream: AbortableAsyncStream<unknown>,
	signal: AbortSignal,
	onAbort: () => Promise<void>,
): Promise<StreamReadResult> {
	return new Promise<StreamReadResult>((resolve) => {
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
			} catch (err) {
				finish(() => resolve(classifyStreamError(err)));
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
			return {
				type: "error",
				message: JSON.stringify(err.properties),
				...extractErrorFields(err.properties.error),
			};
		}
	}
	return null;
}

function extractErrorFields(error: unknown): {
	errorClass?: string;
	status?: number;
	retryable?: boolean;
} {
	if (!error || typeof error !== "object") return {};
	const e = error as { name?: unknown; data?: unknown };
	const errorClass = typeof e.name === "string" ? e.name : undefined;
	if (errorClass !== "APIError") {
		return { errorClass };
	}
	const data = e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
	const status = typeof data.statusCode === "number" ? data.statusCode : undefined;
	const retryable = typeof data.isRetryable === "boolean" ? data.isRetryable : undefined;
	return { errorClass, status, retryable };
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

/** message.part.updated イベントからセッション内のアクティビティをログに出す */
export function logPartActivity(event: Event, sessionId: string, logger: Logger | undefined): void {
	const TEXT_LOG_MAX = 200;
	if (!logger || event.type !== "message.part.updated") return;
	const { part } = event.properties;
	if (part.sessionID !== sessionId) return;

	if (part.type === "text") {
		const text = part.text.trim();
		if (!text) return;
		const preview = text.length > TEXT_LOG_MAX ? `${text.slice(0, TEXT_LOG_MAX)}…` : text;
		logger.info(`[opencode:activity] text: ${preview}`);
	} else if (part.type === "tool") {
		const status = part.state.status;
		if (status === "running") {
			logger.info(`[opencode:activity] tool-start: ${part.tool}`);
		} else if (status === "completed") {
			const elapsed = part.state.time ? `${part.state.time.end - part.state.time.start}ms` : "?";
			logger.info(`[opencode:activity] tool-done: ${part.tool} (${elapsed})`);
		} else if (status === "error") {
			const errMsg = "error" in part.state ? part.state.error : "unknown";
			logger.error(`[opencode:activity] tool-error: ${part.tool}: ${errMsg}`);
		}
	} else if (part.type === "step-finish") {
		const { input: i, output: o, reasoning: r } = part.tokens;
		logger.info(
			`[opencode:activity] step-finish: reason=${part.reason} tokens(in=${i} out=${o} reasoning=${r}) cost=${part.cost}`,
		);
	}
}
