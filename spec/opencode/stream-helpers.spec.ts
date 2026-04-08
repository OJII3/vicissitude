/**
 * Issue #537: stream-helpers の公開 API に対する仕様テスト
 *
 * テスト対象:
 * - nextStreamEvent: ストリームイベント読み取り、タイムアウト、signal abort
 * - returnStreamOnce: stream.return() の冪等呼び出し
 * - classifyEvent: OpenCode イベントの分類
 * - extractText: Part[] からテキスト抽出
 * - extractTokens: トークン情報の変換
 * - sumTokens: トークン合算
 * - abortSession: ベストエフォート停止
 */
import { describe, expect, mock, test } from "bun:test";

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";
import {
	type AbortableAsyncStream,
	abortSession,
	classifyEvent,
	extractText,
	extractTokens,
	nextStreamEvent,
	returnStreamOnce,
	sumTokens,
} from "@vicissitude/opencode/stream-helpers";
import type { TokenUsage } from "@vicissitude/shared/types";

// ─── nextStreamEvent ──────────────────────────────────────────────

describe("nextStreamEvent", () => {
	test("ストリームが値を返した場合、{ type: 'event', value } を返す", async () => {
		const stream: AbortableAsyncStream<unknown> = {
			next: mock(() => Promise.resolve({ done: false, value: { foo: "bar" } })),
		};

		const result = await nextStreamEvent(
			stream,
			undefined,
			mock(() => Promise.resolve()),
		);

		expect(result.type).toBe("event");
		if (result.type !== "event") throw new Error("unreachable");
		expect(result.value).toEqual({ foo: "bar" });
	});

	test("ストリームが done: true で完了した場合、{ type: 'done' } を返す", async () => {
		const stream: AbortableAsyncStream<unknown> = {
			next: mock(() => Promise.resolve({ done: true, value: undefined })),
		};

		const result = await nextStreamEvent(
			stream,
			undefined,
			mock(() => Promise.resolve()),
		);

		expect(result).toEqual({ type: "done" });
	});

	test("stream.next() がタイムアウトで reject した場合、{ type: 'streamTimeout', reason } を返す", async () => {
		const stream: AbortableAsyncStream<unknown> = {
			next: mock(
				() =>
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 5);
					}),
			),
		};

		const result = await nextStreamEvent(
			stream,
			undefined,
			mock(() => Promise.resolve()),
		);

		expect(result.type).toBe("streamTimeout");
		if (result.type !== "streamTimeout") throw new Error("unreachable");
		expect(result.reason).toContain("timed out");
	});

	test("signal が abort された場合、{ type: 'aborted' } を返す", async () => {
		const controller = new AbortController();
		const stream: AbortableAsyncStream<unknown> = {
			// 永遠に解決しない
			next: mock(() => new Promise(() => {})),
			return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
		};
		const onAbort = mock(() => Promise.resolve());

		// 少し遅延してから abort する
		setTimeout(() => controller.abort(), 10);

		const result = await nextStreamEvent(stream, controller.signal, onAbort);

		expect(result).toEqual({ type: "aborted" });
	});

	test("signal abort 時に onAbort コールバックが呼ばれる", async () => {
		const controller = new AbortController();
		const stream: AbortableAsyncStream<unknown> = {
			next: mock(() => new Promise(() => {})),
			return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
		};
		const onAbort = mock(() => Promise.resolve());

		setTimeout(() => controller.abort(), 10);

		await nextStreamEvent(stream, controller.signal, onAbort);

		expect(onAbort).toHaveBeenCalledTimes(1);
	});

	test("signal が既に abort 済みの場合、即座に { type: 'aborted' } を返す", async () => {
		const controller = new AbortController();
		// 事前に abort
		controller.abort();

		const stream: AbortableAsyncStream<unknown> = {
			next: mock(() => new Promise(() => {})),
			return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
		};
		const onAbort = mock(() => Promise.resolve());

		const result = await nextStreamEvent(stream, controller.signal, onAbort);

		expect(result).toEqual({ type: "aborted" });
		expect(onAbort).toHaveBeenCalledTimes(1);
	});
});

// ─── returnStreamOnce ──────────────────────────────────────────────

describe("returnStreamOnce", () => {
	test("stream.return() を 1 回だけ呼ぶ（2 回呼んでも 1 回しか実行されない）", async () => {
		const returnFn = mock(() => Promise.resolve({ done: true as const, value: undefined }));
		const stream: AbortableAsyncStream<unknown> = {
			next: mock(() => Promise.resolve({ done: true, value: undefined })),
			return: returnFn,
		};

		await returnStreamOnce(stream);
		await returnStreamOnce(stream);
		await returnStreamOnce(stream);

		expect(returnFn).toHaveBeenCalledTimes(1);
	});

	test("stream.return が undefined の場合も正常に resolve する", async () => {
		const stream: AbortableAsyncStream<unknown> = {
			next: mock(() => Promise.resolve({ done: true, value: undefined })),
			// return は未定義
		};

		const result = await returnStreamOnce(stream);
		expect(result).toBeUndefined();
	});
});

// ─── classifyEvent ──────────────────────────────────────────────

describe("classifyEvent", () => {
	const sessionId = "test-session";

	test("session.idle イベントで { type: 'idle', tokens } を返す", () => {
		const tokensByMessage = new Map<string, TokenUsage>([
			["msg-1", { input: 100, output: 50, cacheRead: 10 }],
		]);
		const event = {
			type: "session.idle",
			properties: { sessionID: sessionId },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, tokensByMessage);

		expect(result).not.toBeNull();
		expect(result?.type).toBe("idle");
		if (result?.type !== "idle") throw new Error("unreachable");
		expect(result.tokens).toEqual({ input: 100, output: 50, cacheRead: 10 });
	});

	test("session.error イベントで { type: 'error', message } を返す", () => {
		const event = {
			type: "session.error",
			properties: { sessionID: sessionId, code: "INTERNAL" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).not.toBeNull();
		expect(result?.type).toBe("error");
		if (result?.type !== "error") throw new Error("unreachable");
		expect(typeof result.message).toBe("string");
		expect(result.message.length).toBeGreaterThan(0);
	});

	test("session.compacted イベントで { type: 'compacted' } を返す", () => {
		const event = {
			type: "session.compacted",
			properties: { sessionID: sessionId },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).toEqual({ type: "compacted" });
	});

	test("message.updated イベントはトークンを蓄積し null を返す", () => {
		const tokensByMessage = new Map<string, TokenUsage>();
		const event = {
			type: "message.updated",
			properties: {
				info: {
					role: "assistant",
					sessionID: sessionId,
					id: "msg-1",
					tokens: { input: 100, output: 50, cache: { read: 10 } },
				},
			},
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, tokensByMessage);

		expect(result).toBeNull();
		// トークンが蓄積されている
		expect(tokensByMessage.has("msg-1")).toBe(true);
		expect(tokensByMessage.get("msg-1")).toEqual({
			input: 100,
			output: 50,
			cacheRead: 10,
		});
	});

	test("別セッション ID のイベントは null を返す", () => {
		const event = {
			type: "session.idle",
			properties: { sessionID: "other-session" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).toBeNull();
	});
});

// ─── extractText ──────────────────────────────────────────────

describe("extractText", () => {
	test("text パーツのテキストを結合する", () => {
		const parts = [
			{ type: "text" as const, text: "Hello, " },
			{ type: "text" as const, text: "world!" },
		];

		const result = extractText(parts);

		expect(result).toBe("Hello, world!");
	});

	test("text 以外のパーツを無視する", () => {
		const parts = [
			{ type: "text" as const, text: "Hello" },
			{
				type: "tool-invocation" as const,
				toolInvocationId: "t1",
				toolName: "test",
				state: "result" as const,
			},
			{ type: "text" as const, text: " world" },
		];

		// extractText は Part[] を受け取るが、型の詳細は SDK 依存なので as unknown で渡す
		const result = extractText(parts as never);

		expect(result).toBe("Hello world");
	});
});

// ─── extractTokens ──────────────────────────────────────────────

describe("extractTokens", () => {
	test("tokens フィールドがあれば TokenUsage を返す", () => {
		const result = extractTokens({
			tokens: { input: 100, output: 50, cache: { read: 10 } },
		});

		expect(result).toEqual({ input: 100, output: 50, cacheRead: 10 });
	});

	test("cache が省略されている場合、cacheRead は 0 になる", () => {
		const result = extractTokens({
			tokens: { input: 100, output: 50 },
		});

		expect(result).toEqual({ input: 100, output: 50, cacheRead: 0 });
	});

	test("tokens フィールドがなければ undefined を返す", () => {
		const result = extractTokens({});

		expect(result).toBeUndefined();
	});
});

// ─── sumTokens ──────────────────────────────────────────────

describe("sumTokens", () => {
	test("空マップで undefined を返す", () => {
		const result = sumTokens(new Map());

		expect(result).toBeUndefined();
	});

	test("複数エントリを合算する", () => {
		const map = new Map<string, TokenUsage>([
			["msg-1", { input: 100, output: 50, cacheRead: 10 }],
			["msg-2", { input: 200, output: 80, cacheRead: 20 }],
			["msg-3", { input: 50, output: 30, cacheRead: 5 }],
		]);

		const result = sumTokens(map);

		expect(result).toEqual({ input: 350, output: 160, cacheRead: 35 });
	});
});

// ─── abortSession ──────────────────────────────────────────────

describe("abortSession", () => {
	test("エラーが発生してもスローしない（ベストエフォート）", async () => {
		const client = {
			session: {
				abort: mock(() => Promise.reject(new Error("connection refused"))),
			},
		} as unknown as OpencodeClient;

		// エラーがスローされないことを確認
		const result = await abortSession(client, "session-1");
		expect(result).toBeUndefined();
	});
});
