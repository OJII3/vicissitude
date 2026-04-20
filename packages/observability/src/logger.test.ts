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

	// ─── child() 内部詳細 ────────────────────────────────────────

	describe("child() 内部詳細", () => {
		test("child() は ConsoleLogger のインスタンスを返す", () => {
			setup();
			const parent = new ConsoleLogger({ level: "info" });
			const child = parent.child({ trace_id: "abc" });

			expect(child).toBeInstanceOf(ConsoleLogger);
		});

		test("child() で生成した logger は親とは別の内部 pino インスタンスを持つ", () => {
			setup();
			const parent = new ConsoleLogger({ level: "info" });
			const child = parent.child({ trace_id: "xyz" });

			// Object.create パターンで作られた child は独自の pino フィールドを持つ
			const parentPino = (parent as unknown as { pino: unknown }).pino;
			const childPino = (child as unknown as { pino: unknown }).pino;

			expect(childPino).not.toBe(parentPino);
		});

		test("child() 後も parent の出力に child の bindings が混入しない", () => {
			setup();
			const parent = new ConsoleLogger({ level: "info" });
			parent.child({ trace_id: "child-only" });

			parent.info("parent message");

			const entry = JSON.parse(stdoutCapture.calls[0]!);
			expect(entry.msg).toBe("parent message");
			expect(entry.trace_id).toBeUndefined();
		});

		test("destination: 'stderr' の parent から child() した場合 stdout には出力されない", () => {
			setup();
			const parent = new ConsoleLogger({
				level: "info",
				destination: "stderr",
			});
			const child = parent.child({ trace_id: "stderr-test" });

			child.info("stderr child message");

			// pino.destination(2) は fd 2 に直接書き込むため process.stderr.write は経由しない
			// stdout に出力されないことで、child が親の destination を引き継いでいることを確認
			expect(stdoutCapture.calls).toHaveLength(0);
		});
	});
});
