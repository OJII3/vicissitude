/**
 * consumeSessionEventStream（共通イベント監視ループ）の契約仕様テスト
 *
 * promptAsyncAndWatchSession / waitForSessionIdle が共有する受信ループの振る舞いを固定する。
 * 送信（promptAsync）・subscribe・returnStreamOnce は呼び出し側の責務であり、この関数の対象外。
 *
 * 期待仕様:
 * 1. done イベントで { type: "idle" } を蓄積トークン付きで返す
 * 2. aborted イベントで { type: "cancelled" } を返す
 * 3. streamTimeout / streamError で { type: "streamDisconnected" } を蓄積トークン付きで返す
 * 4. classifyEvent が終端イベントを返したらそれを返す（idle / error 等）
 * 5. message.updated のトークンが蓄積され、終端イベントに合算で含まれる
 * 6. message.part.updated の activity が onActivity に渡される
 * 7. session.error は error レベルでログ出力し、終端として返る
 * 8. ログ文言は log.prefix でプレフィックスされ、log.logClassifiedSuccess で分類成功 info の有無を制御する
 */
import { describe, expect, mock, test } from "bun:test";

import type { Event } from "@opencode-ai/sdk/v2";
import {
	consumeSessionEventStream,
	type SessionEventStreamLogConfig,
} from "@vicissitude/opencode/session-event-stream";
import type { AbortableAsyncStream } from "@vicissitude/opencode/stream-helpers";
import type { Logger, OpencodeSessionActivity, TokenUsage } from "@vicissitude/shared/types";

// ─── テストヘルパー ──────────────────────────────────────────────

function makeLogger() {
	const logger = {
		debug: mock((..._args: unknown[]) => {}),
		info: mock((..._args: unknown[]) => {}),
		warn: mock((..._args: unknown[]) => {}),
		error: mock((..._args: unknown[]) => {}),
		child: () => logger as unknown as Logger,
	};
	return logger;
}

/** 与えた events を順に返し、その後は永遠に解決しない stream を作る */
function makeStream(events: Event[]): AbortableAsyncStream<unknown> {
	let i = 0;
	return {
		next: mock(() => {
			if (i < events.length) {
				const value = events[i] as Event;
				i++;
				return Promise.resolve<IteratorResult<Event, void>>({ done: false, value });
			}
			return new Promise<IteratorResult<Event, void>>(() => {});
		}),
		return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
	} as unknown as AbortableAsyncStream<unknown>;
}

/** events を返し終えたら done を返す stream */
function makeStreamThenDone(events: Event[]): AbortableAsyncStream<unknown> {
	let i = 0;
	return {
		next: mock(() => {
			if (i < events.length) {
				const value = events[i] as Event;
				i++;
				return Promise.resolve<IteratorResult<Event, void>>({ done: false, value });
			}
			return Promise.resolve<IteratorResult<Event, void>>({ done: true, value: undefined });
		}),
		return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
	} as unknown as AbortableAsyncStream<unknown>;
}

/** events を返し終えたら timeout エラーで reject する stream（SSE 切断シミュレート） */
function makeStreamThenTimeout(events: Event[]): AbortableAsyncStream<unknown> {
	let i = 0;
	return {
		next: mock(() => {
			if (i < events.length) {
				const value = events[i] as Event;
				i++;
				return Promise.resolve<IteratorResult<Event, void>>({ done: false, value });
			}
			return new Promise<IteratorResult<Event, void>>((_resolve, reject) => {
				setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 10);
			});
		}),
		return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
	} as unknown as AbortableAsyncStream<unknown>;
}

function makeMessageUpdatedEvent(
	sessionId: string,
	messageId: string,
	tokens: { input: number; output: number; cache: { read: number } },
): Event {
	return {
		type: "message.updated",
		properties: {
			info: { role: "assistant", sessionID: sessionId, id: messageId, tokens },
		},
	} as unknown as Event;
}

function makeSessionIdleEvent(sessionId: string): Event {
	return {
		type: "session.idle",
		properties: { sessionID: sessionId },
	} as unknown as Event;
}

function makeSessionErrorEvent(sessionId: string): Event {
	return {
		type: "session.error",
		properties: { sessionID: sessionId, code: "INTERNAL" },
	} as unknown as Event;
}

function makeToolPartEvent(sessionId: string): Event {
	return {
		type: "message.part.updated",
		properties: {
			sessionID: sessionId,
			part: {
				sessionID: sessionId,
				type: "tool",
				tool: "search_code",
				state: { status: "running", input: {} },
			},
		},
	} as unknown as Event;
}

const promptLog: SessionEventStreamLogConfig = { prefix: "", logClassifiedSuccess: true };
const waitIdleLog: SessionEventStreamLogConfig = {
	prefix: "waitIdle: ",
	logClassifiedSuccess: false,
};

function run(
	stream: AbortableAsyncStream<unknown>,
	opts: {
		signal?: AbortSignal;
		sessionId?: string;
		onAbort?: () => Promise<void>;
		tokensByMessage?: Map<string, TokenUsage>;
		onActivity?: (a: OpencodeSessionActivity) => void;
		logger?: ReturnType<typeof makeLogger>;
		log?: SessionEventStreamLogConfig;
	} = {},
) {
	return consumeSessionEventStream({
		stream,
		signal: opts.signal,
		sessionId: opts.sessionId ?? "session-1",
		onAbort: opts.onAbort ?? (() => Promise.resolve()),
		tokensByMessage: opts.tokensByMessage ?? new Map<string, TokenUsage>(),
		onActivity: opts.onActivity,
		logger: opts.logger as unknown as Logger | undefined,
		log: opts.log ?? promptLog,
	});
}

// ─── 終端イベント ────────────────────────────────────────────────

describe("consumeSessionEventStream: 終端イベント", () => {
	test("stream done で idle を返す", async () => {
		const result = await run(makeStreamThenDone([]));
		expect(result.type).toBe("idle");
	});

	test("session.idle イベントで idle を返す", async () => {
		const result = await run(makeStream([makeSessionIdleEvent("session-1")]));
		expect(result.type).toBe("idle");
	});

	test("signal abort で cancelled を返す", async () => {
		const controller = new AbortController();
		const stream = makeStream([]);
		const promise = run(stream, { signal: controller.signal });
		controller.abort();
		const result = await promise;
		expect(result.type).toBe("cancelled");
	});

	test("stream timeout で streamDisconnected を返す", async () => {
		const result = await run(makeStreamThenTimeout([]));
		expect(result.type).toBe("streamDisconnected");
	});

	test("session.error で error を返す", async () => {
		const result = await run(makeStream([makeSessionErrorEvent("session-1")]));
		expect(result.type).toBe("error");
	});
});

// ─── トークン蓄積 ────────────────────────────────────────────────

describe("consumeSessionEventStream: トークン蓄積", () => {
	test("複数 message.updated のトークンが idle に合算される", async () => {
		const stream = makeStreamThenDone([
			makeMessageUpdatedEvent("session-1", "msg-1", {
				input: 100,
				output: 50,
				cache: { read: 10 },
			}),
			makeMessageUpdatedEvent("session-1", "msg-2", {
				input: 200,
				output: 80,
				cache: { read: 20 },
			}),
		]);

		const result = await run(stream);

		expect(result.type).toBe("idle");
		if (result.type !== "idle") throw new Error("unreachable");
		expect(result.tokens).toEqual({ input: 300, output: 130, cacheRead: 30 });
	});

	test("SSE 切断時にも蓄積トークンが streamDisconnected に含まれる", async () => {
		const stream = makeStreamThenTimeout([
			makeMessageUpdatedEvent("session-1", "msg-1", {
				input: 150,
				output: 60,
				cache: { read: 15 },
			}),
		]);

		const result = await run(stream);

		expect(result.type).toBe("streamDisconnected");
		if (result.type !== "streamDisconnected") throw new Error("unreachable");
		expect(result.tokens).toEqual({ input: 150, output: 60, cacheRead: 15 });
	});

	test("トークン蓄積なしで SSE 切断時は tokens が undefined", async () => {
		const result = await run(makeStreamThenTimeout([]));
		expect(result.type).toBe("streamDisconnected");
		if (result.type !== "streamDisconnected") throw new Error("unreachable");
		expect(result.tokens).toBeUndefined();
	});
});

// ─── onActivity コールバック ─────────────────────────────────────

describe("consumeSessionEventStream: onActivity", () => {
	test("message.part.updated の tool activity が onActivity に渡される", async () => {
		const onActivity = mock((_a: OpencodeSessionActivity) => {});
		const stream = makeStreamThenDone([makeToolPartEvent("session-1")]);

		await run(stream, { onActivity });

		expect(onActivity).toHaveBeenCalledTimes(1);
		expect(onActivity.mock.calls[0]?.[0]).toEqual({
			type: "tool",
			tool: "search_code",
			status: "running",
		});
	});
});

// ─── ログ挙動の差分吸収 ──────────────────────────────────────────

describe("consumeSessionEventStream: ログ挙動", () => {
	test("session.error は error レベルでエラー詳細付きでログ出力する", async () => {
		const logger = makeLogger();
		const result = await run(makeStream([makeSessionErrorEvent("session-1")]), { logger });

		expect(result.type).toBe("error");
		expect(logger.error.mock.calls.length).toBeGreaterThanOrEqual(1);
		const errorMessages = logger.error.mock.calls.map((c) => JSON.stringify(c));
		expect(errorMessages.some((m) => m.includes("session.error") && m.includes("INTERNAL"))).toBe(
			true,
		);
	});

	test("prefix が指定された場合、ログ文言にプレフィックスが付く（waitIdle）", async () => {
		const logger = makeLogger();
		await run(makeStreamThenDone([]), { logger, log: waitIdleLog });

		const infoMessages = logger.info.mock.calls.map((c) => String(c[0]));
		expect(infoMessages.some((m) => m.includes("waitIdle: event stream done (idle)"))).toBe(true);
	});

	test("logClassifiedSuccess=true の場合、分類成功イベントを info ログに出す", async () => {
		const logger = makeLogger();
		await run(makeStream([makeSessionIdleEvent("session-1")]), { logger, log: promptLog });

		const infoMessages = logger.info.mock.calls.map((c) => String(c[0]));
		expect(infoMessages.some((m) => m.includes("session event: idle"))).toBe(true);
	});

	test("logClassifiedSuccess=false の場合、分類成功イベントを info ログに出さない", async () => {
		const logger = makeLogger();
		await run(makeStream([makeSessionIdleEvent("session-1")]), { logger, log: waitIdleLog });

		const infoMessages = logger.info.mock.calls.map((c) => String(c[0]));
		expect(infoMessages.some((m) => m.includes("session event:"))).toBe(false);
	});

	test("logger 未設定でもエラーにならない", async () => {
		const result = await run(makeStreamThenDone([]), { logger: undefined });
		expect(result.type).toBe("idle");
	});
});
