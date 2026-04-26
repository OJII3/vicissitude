/**
 * Issue #537: stream-helpers の公開 API に対する仕様テスト (2/2)
 *
 * テスト対象:
 * - extractText: Part[] からテキスト抽出
 * - extractTokens: トークン情報の変換
 * - sumTokens: トークン合算
 * - abortSession: ベストエフォート停止
 * - logPartActivity: セッション内アクティビティのログ出力
 *
 * 前半の関数は stream-helpers.spec.ts で検証する。
 */
import { describe, expect, mock, test } from "bun:test";

import type { Event, OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import {
	abortSession,
	extractText,
	extractTokens,
	logPartActivity,
	sumTokens,
} from "@vicissitude/opencode/stream-helpers";
import type { TokenUsage } from "@vicissitude/shared/types";

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
		const logger = {
			info: mock((msg: string) => {
				infoMessages.push(msg);
			}),
			error: mock((msg: string) => {
				errorMessages.push(msg);
			}),
			warn: mock(() => {}),
			debug: mock(() => {}),
			child: () => logger,
			infoMessages,
			errorMessages,
		};
		return logger;
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
