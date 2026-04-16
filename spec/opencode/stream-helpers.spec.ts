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
 * - logPartActivity: セッション内アクティビティのログ出力
 */
import { describe, expect, mock, test } from "bun:test";

import type { Event, OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import {
	type AbortableAsyncStream,
	abortSession,
	classifyEvent,
	extractText,
	extractTokens,
	logPartActivity,
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
		const stream = {
			next: mock(
				() =>
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 5);
					}),
			),
		} as AbortableAsyncStream<unknown>;

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
		const stream = {
			// 永遠に解決しない
			next: mock(() => new Promise(() => {})),
			return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
		} as AbortableAsyncStream<unknown>;
		const onAbort = mock(() => Promise.resolve());

		// 少し遅延してから abort する
		setTimeout(() => controller.abort(), 10);

		const result = await nextStreamEvent(stream, controller.signal, onAbort);

		expect(result).toEqual({ type: "aborted" });
	});

	test("signal abort 時に onAbort コールバックが呼ばれる", async () => {
		const controller = new AbortController();
		const stream = {
			next: mock(() => new Promise(() => {})),
			return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
		} as AbortableAsyncStream<unknown>;
		const onAbort = mock(() => Promise.resolve());

		setTimeout(() => controller.abort(), 10);

		await nextStreamEvent(stream, controller.signal, onAbort);

		expect(onAbort).toHaveBeenCalledTimes(1);
	});

	test("signal が既に abort 済みの場合、即座に { type: 'aborted' } を返す", async () => {
		const controller = new AbortController();
		// 事前に abort
		controller.abort();

		const stream = {
			next: mock(() => new Promise(() => {})),
			return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
		} as AbortableAsyncStream<unknown>;
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

	test("session.error で APIError ペイロードの場合、structured フィールドを含む", () => {
		const event = {
			type: "session.error",
			properties: {
				sessionID,
				error: {
					name: "APIError",
					data: {
						message: "Bad Request",
						statusCode: 400,
						isRetryable: false,
					},
				},
			},
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).not.toBeNull();
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.status).toBe(400);
		expect(result.retryable).toBe(false);
		expect(result.errorClass).toBe("APIError");
	});

	test("session.error で 5xx かつ isRetryable=true のペイロード", () => {
		const event = {
			type: "session.error",
			properties: {
				sessionID,
				error: {
					name: "APIError",
					data: {
						message: "Upstream timeout",
						statusCode: 502,
						isRetryable: true,
					},
				},
			},
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.status).toBe(502);
		expect(result.retryable).toBe(true);
		expect(result.errorClass).toBe("APIError");
	});

	test("session.error で ApiError 以外のエラー種別では status/retryable が undefined", () => {
		const event = {
			type: "session.error",
			properties: {
				sessionID,
				error: {
					name: "UnknownError",
					data: { message: "oops" },
				},
			},
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.status).toBeUndefined();
		expect(result.retryable).toBeUndefined();
		expect(result.errorClass).toBe("UnknownError");
	});

	test("session.error で error プロパティ自体がない場合、全て undefined", () => {
		const event = {
			type: "session.error",
			properties: { sessionID },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.status).toBeUndefined();
		expect(result.retryable).toBeUndefined();
		expect(result.errorClass).toBeUndefined();
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
		] as Part[];

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

// ─── logPartActivity ──────────────────────────────────────────────

describe("logPartActivity", () => {
	const sessionId = "test-session";

	function makeLogger() {
		const infoMessages: string[] = [];
		const errorMessages: string[] = [];
		return {
			info: mock((msg: string) => {
				infoMessages.push(msg);
			}),
			error: mock((msg: string) => {
				errorMessages.push(msg);
			}),
			warn: mock(() => {}),
			debug: mock(() => {}),
			infoMessages,
			errorMessages,
		};
	}

	function makePartEvent(partProps: Record<string, unknown>, sid: string = sessionId): Event {
		return {
			type: "message.part.updated",
			properties: {
				part: { sessionID: sid, ...partProps },
			},
		} as unknown as Event;
	}

	test("text パートのログ出力", () => {
		const logger = makeLogger();
		const event = makePartEvent({ type: "text", text: "Hello world" });

		logPartActivity(event, sessionId, logger);

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.infoMessages[0]).toContain("[opencode:activity] text:");
		expect(logger.infoMessages[0]).toContain("Hello world");
	});

	test("text パートが空白のみの場合はログを出力しない", () => {
		const logger = makeLogger();
		const event = makePartEvent({ type: "text", text: "   \n  " });

		logPartActivity(event, sessionId, logger);

		expect(logger.info).not.toHaveBeenCalled();
	});

	test("text パートが長い場合は切り詰める", () => {
		const logger = makeLogger();
		const longText = "a".repeat(300);
		const event = makePartEvent({ type: "text", text: longText });

		logPartActivity(event, sessionId, logger);

		expect(logger.info).toHaveBeenCalledTimes(1);
		// 200 文字 + "…" で切り詰められる
		expect(logger.infoMessages[0]?.length).toBeLessThan(longText.length + 50);
	});

	test("tool パート（running）のログ出力", () => {
		const logger = makeLogger();
		const event = makePartEvent({
			type: "tool",
			tool: "search_code",
			state: { status: "running" },
		});

		logPartActivity(event, sessionId, logger);

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.infoMessages[0]).toContain("[opencode:activity] tool-start:");
		expect(logger.infoMessages[0]).toContain("search_code");
	});

	test("tool パート（completed）のログ出力", () => {
		const logger = makeLogger();
		const event = makePartEvent({
			type: "tool",
			tool: "read_file",
			state: { status: "completed", time: { start: 1000, end: 1500 } },
		});

		logPartActivity(event, sessionId, logger);

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.infoMessages[0]).toContain("[opencode:activity] tool-done:");
		expect(logger.infoMessages[0]).toContain("read_file");
		expect(logger.infoMessages[0]).toContain("500ms");
	});

	test("tool パート（error）のログ出力", () => {
		const logger = makeLogger();
		const event = makePartEvent({
			type: "tool",
			tool: "write_file",
			state: { status: "error", error: "permission denied" },
		});

		logPartActivity(event, sessionId, logger);

		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.errorMessages[0]).toContain("[opencode:activity] tool-error:");
		expect(logger.errorMessages[0]).toContain("write_file");
		expect(logger.errorMessages[0]).toContain("permission denied");
	});

	test("step-finish パートのログ出力", () => {
		const logger = makeLogger();
		const event = makePartEvent({
			type: "step-finish",
			reason: "end_turn",
			tokens: { input: 1000, output: 500, reasoning: 200 },
			cost: 0.05,
		});

		logPartActivity(event, sessionId, logger);

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.infoMessages[0]).toContain("[opencode:activity] step-finish:");
		expect(logger.infoMessages[0]).toContain("reason=end_turn");
		expect(logger.infoMessages[0]).toContain("in=1000");
		expect(logger.infoMessages[0]).toContain("out=500");
		expect(logger.infoMessages[0]).toContain("reasoning=200");
		expect(logger.infoMessages[0]).toContain("cost=0.05");
	});

	test("sessionId が異なる場合にログが出ない", () => {
		const logger = makeLogger();
		const event = makePartEvent({ type: "text", text: "Hello" }, "other-session");

		logPartActivity(event, sessionId, logger);

		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("logger が undefined の場合にエラーにならない", () => {
		const event = makePartEvent({ type: "text", text: "Hello" });

		// エラーなく完了すること
		const noLogger: undefined = void 0;
		expect(() => logPartActivity(event, sessionId, noLogger)).not.toThrow();
	});

	test("message.part.updated 以外のイベントは無視する", () => {
		const logger = makeLogger();
		const event = {
			type: "session.idle",
			properties: { sessionID: sessionId },
		} as unknown as Event;

		logPartActivity(event, sessionId, logger);

		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});
});
