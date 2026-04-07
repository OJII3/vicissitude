import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ConsoleLogger } from "@vicissitude/observability/logger";

function captureWrite(stream: "stdout" | "stderr") {
	const original = process[stream].write;
	const calls: string[] = [];
	process[stream].write = ((...args: unknown[]) => {
		calls.push(args[0] as string);
		return true;
	}) as typeof process.stdout.write;
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

	beforeEach(() => {
		stdoutCapture = captureWrite("stdout");
		stderrCapture = captureWrite("stderr");
	});

	afterEach(() => {
		stdoutCapture?.restore();
		stderrCapture?.restore();
	});

	function output(): string {
		return [...stdoutCapture.calls, ...stderrCapture.calls].join("");
	}

	// ─── ログレベルフィルタリング ────────────────────────────────

	describe("ログレベルフィルタリング", () => {
		it("info レベルで debug() は出力されない", () => {
			const logger = new ConsoleLogger("info");
			logger.debug("should not appear");

			expect(output()).toBe("");
		});

		it("debug レベルで debug() が出力される", () => {
			const logger = new ConsoleLogger("debug");
			logger.debug("visible");

			expect(output()).toContain("visible");
		});

		it("info レベルで info() が出力される", () => {
			const logger = new ConsoleLogger("info");
			logger.info("info message");

			expect(output()).toContain("info message");
		});

		it("info レベルで warn() が出力される", () => {
			const logger = new ConsoleLogger("info");
			logger.warn("warn message");

			expect(output()).toContain("warn message");
		});

		it("info レベルで error() が出力される", () => {
			const logger = new ConsoleLogger("info");
			logger.error("error message");

			expect(output()).toContain("error message");
		});

		it("デフォルトレベルでは debug() が抑制される", () => {
			const logger = new ConsoleLogger();
			logger.debug("hidden");

			expect(output()).toBe("");
		});
	});

	// ─── メッセージの保存 ────────────────────────────────────────

	it("出力にメッセージ文字列が含まれる", () => {
		const logger = new ConsoleLogger();
		logger.info("unique-test-message-12345");

		expect(output()).toContain("unique-test-message-12345");
	});

	// ─── extra 引数の格納 ────────────────────────────────────────

	describe("extra 引数の格納", () => {
		it("単一オブジェクト引数の内容が出力に含まれる", () => {
			const logger = new ConsoleLogger();
			logger.info("with data", { key: "value" });

			const out = output();
			expect(out).toContain("with data");
			expect(out).toContain("key");
			expect(out).toContain("value");
		});

		it("複数引数の内容が出力に含まれる", () => {
			const logger = new ConsoleLogger();
			logger.info("multi", "a", 42);

			const out = output();
			expect(out).toContain("multi");
			expect(out).toContain("a");
			expect(out).toContain("42");
		});

		it("引数なしでもメッセージは出力される", () => {
			const logger = new ConsoleLogger();
			logger.info("no extra");

			expect(output()).toContain("no extra");
		});
	});
});
