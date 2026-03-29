/* oxlint-disable no-non-null-assertion -- test assertions */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { ConsoleLogger } from "./logger.ts";

function captureWrite(stream: "stdout" | "stderr") {
	const original = process[stream].write;
	const calls: string[] = [];
	process[stream].write = mock((...args: unknown[]) => {
		calls.push(args[0] as string);
		return true;
	});
	return {
		calls,
		restore() {
			process[stream].write = original;
		},
	};
}

describe("ConsoleLogger", () => {
	let stdoutCapture: ReturnType<typeof captureWrite>;
	let stderrCapture: ReturnType<typeof captureWrite>;

	// beforeEach ではなく各テスト冒頭で呼ぶ: afterEach の restore() が
	// 前のテストの capture を参照するため、初期化順を明示的に制御する
	function setup() {
		stdoutCapture = captureWrite("stdout");
		stderrCapture = captureWrite("stderr");
	}

	afterEach(() => {
		stdoutCapture?.restore();
		stderrCapture?.restore();
	});

	test("info() → stdout に JSON 出力、level='info'", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.info("hello");

		expect(stdoutCapture.calls).toHaveLength(1);
		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.level).toBe("info");
		expect(entry.message).toBe("hello");
		expect(entry.timestamp).toBeDefined();
	});

	test("error() → stderr に JSON 出力、level='error'", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.error("oops");

		expect(stderrCapture.calls).toHaveLength(1);
		const entry = JSON.parse(stderrCapture.calls[0]!);
		expect(entry.level).toBe("error");
		expect(entry.message).toBe("oops");
	});

	test("warn() → stderr に JSON 出力、level='warn'", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.warn("caution");

		expect(stderrCapture.calls).toHaveLength(1);
		const entry = JSON.parse(stderrCapture.calls[0]!);
		expect(entry.level).toBe("warn");
		expect(entry.message).toBe("caution");
	});

	test("[component] message → component フィールド抽出", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.info("[scheduler] tick done");

		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.component).toBe("scheduler");
		expect(entry.message).toBe("tick done");
	});

	test("component なし → component フィールドなし", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.info("plain message");

		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.component).toBeUndefined();
		expect(entry.message).toBe("plain message");
	});

	test("Error 引数 → { name, message, stack } にシリアライズ", () => {
		setup();
		const logger = new ConsoleLogger();
		const err = new Error("fail");
		logger.error("something broke", err);

		const entry = JSON.parse(stderrCapture.calls[0]!);
		expect(entry.extra).toEqual({
			name: "Error",
			message: "fail",
			stack: err.stack,
		});
	});

	test("複数引数 → extra が配列", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.info("multi", "a", 42);

		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.extra).toEqual(["a", 42]);
	});

	test("JSON.stringify 失敗（循環参照）→ フォールバック出力", () => {
		setup();
		const logger = new ConsoleLogger();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		logger.info("msg", circular);

		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.level).toBe("info");
		expect(entry.error).toBe("Failed to serialize log entry");
	});
});
