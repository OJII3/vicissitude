/**
 * Issue #537: stream-helpers の公開 API に対する仕様テスト (1/2)
 *
 * テスト対象:
 * - nextStreamEvent: ストリームイベント読み取り、タイムアウト、signal abort
 * - returnStreamOnce: stream.return() の冪等呼び出し
 * - classifyEvent: OpenCode イベントの分類
 *
 * 残りの関数は stream-helpers-extract.spec.ts で検証する。
 */
import { describe, expect, mock, test } from "bun:test";

import type { Event } from "@opencode-ai/sdk/v2";
import {
	type AbortableAsyncStream,
	classifyEvent,
	nextStreamEvent,
	returnStreamOnce,
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
				sessionID: sessionId,
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
				sessionID: sessionId,
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

	test("session.error で APIError 以外のエラー種別では status/retryable が undefined", () => {
		const event = {
			type: "session.error",
			properties: {
				sessionID: sessionId,
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
			properties: { sessionID: sessionId },
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

	test("session.deleted イベントで { type: 'deleted' } を返す", () => {
		// SDK v2 の EventSessionDeleted は properties.info: Session を持ち、
		// セッション ID は info.id で識別する
		const event = {
			type: "session.deleted",
			properties: { info: { id: sessionId } },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).toEqual({ type: "deleted" });
	});

	test("別セッション ID の session.deleted は null を返す", () => {
		const event = {
			type: "session.deleted",
			properties: { info: { id: "other-session" } },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).toBeNull();
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

	test("session.error で sessionID が undefined の場合もエラーとして扱う", () => {
		// SDK v2 では EventSessionError.properties.sessionID は optional。
		// OpenCode がサーバ全体のエラーとして sessionID 無しで session.error を
		// 発火した場合、現在監視中のセッションに対しても終端エラーとして扱う必要がある。
		const event = {
			type: "session.error",
			properties: {
				error: {
					name: "APIError",
					data: {
						message: "Server-wide failure",
						statusCode: 500,
						isRetryable: false,
					},
				},
			},
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).not.toBeNull();
		expect(result?.type).toBe("error");
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.errorClass).toBe("APIError");
	});

	test("session.error で別セッション ID の場合は null を返す（sessionID 未設定ケースと区別）", () => {
		const event = {
			type: "session.error",
			properties: {
				sessionID: "other-session",
				error: {
					name: "APIError",
					data: {
						message: "Other session failure",
						statusCode: 500,
						isRetryable: false,
					},
				},
			},
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).toBeNull();
	});

	// ─── workspace イベント (#663) ─────────────────────────────────

	test("workspace.failed イベントが error として classify される", () => {
		const event = {
			type: "workspace.failed",
			properties: { message: "workspace init failed" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).not.toBeNull();
		expect(result?.type).toBe("error");
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.message).toContain("workspace init failed");
		expect(result.retryable).toBe(true);
		expect(result.errorClass).toBe("WorkspaceFailed");
	});

	test("workspace.status (status='error') が error として classify される", () => {
		const event = {
			type: "workspace.status",
			properties: { workspaceID: "ws-1", status: "error", error: "connection reset" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).not.toBeNull();
		expect(result?.type).toBe("error");
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.message).toContain("connection reset");
		expect(result.retryable).toBe(true);
		expect(result.errorClass).toBe("WorkspaceError");
	});

	test("workspace.status (status='error') で error フィールドが未設定の場合はデフォルトメッセージ", () => {
		const event = {
			type: "workspace.status",
			properties: { workspaceID: "ws-1", status: "error" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).not.toBeNull();
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.message).toContain("workspace error");
		expect(result.retryable).toBe(true);
		expect(result.errorClass).toBe("WorkspaceError");
	});

	test("workspace.status (status='disconnected') が error として classify される", () => {
		const event = {
			type: "workspace.status",
			properties: { workspaceID: "ws-1", status: "disconnected" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).not.toBeNull();
		expect(result?.type).toBe("error");
		if (result?.type !== "error") throw new Error("unreachable");
		expect(result.message).toContain("workspace disconnected");
		expect(result.retryable).toBe(true);
		expect(result.errorClass).toBe("WorkspaceDisconnected");
	});

	test("workspace.ready イベントが null を返す", () => {
		const event = {
			type: "workspace.ready",
			properties: { name: "my-workspace" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).toBeNull();
	});

	test("workspace.status (status='connected') が null を返す", () => {
		const event = {
			type: "workspace.status",
			properties: { workspaceID: "ws-1", status: "connected" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).toBeNull();
	});

	test("workspace.status (status='connecting') が null を返す", () => {
		const event = {
			type: "workspace.status",
			properties: { workspaceID: "ws-1", status: "connecting" },
		} as unknown as Event;

		const result = classifyEvent(event, sessionId, new Map());

		expect(result).toBeNull();
	});
});
