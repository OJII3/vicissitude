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

	function setup() {
		stdoutCapture = captureWrite("stdout");
		stderrCapture = captureWrite("stderr");
	}

	afterEach(() => {
		stdoutCapture?.restore();
		stderrCapture?.restore();
	});

	test("info() → JSON 出力、level=30", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.info("hello");

		expect(stdoutCapture.calls).toHaveLength(1);
		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.level).toBe(30);
		expect(entry.msg).toBe("hello");
		expect(entry.time).toBeDefined();
	});

	test("error() → JSON 出力、level=50", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.error("oops");

		expect(stdoutCapture.calls).toHaveLength(1);
		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.level).toBe(50);
		expect(entry.msg).toBe("oops");
	});

	test("warn() → JSON 出力、level=40", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.warn("caution");

		expect(stdoutCapture.calls).toHaveLength(1);
		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.level).toBe(40);
		expect(entry.msg).toBe("caution");
	});

	test("debug() → level=20（debug レベル有効時のみ出力）", () => {
		setup();
		const logger = new ConsoleLogger({ level: "debug" });
		logger.debug("trace info");

		expect(stdoutCapture.calls).toHaveLength(1);
		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.level).toBe(20);
		expect(entry.msg).toBe("trace info");
	});

	test("debug() → info レベルでは出力されない", () => {
		setup();
		const logger = new ConsoleLogger({ level: "info" });
		logger.debug("should not appear");

		expect(stdoutCapture.calls).toHaveLength(0);
	});

	test("extra 引数 → extra フィールドに格納", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.info("with data", { key: "value" });

		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.extra).toEqual({ key: "value" });
	});

	test("複数引数 → extra が配列", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.info("multi", "a", 42);

		const entry = JSON.parse(stdoutCapture.calls[0]!);
		expect(entry.extra).toEqual(["a", 42]);
	});
});
