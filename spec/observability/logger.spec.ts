/* oxlint-disable no-non-null-assertion -- test assertions */
import { afterEach, describe, expect, it } from "bun:test";

import { ConsoleLogger } from "@vicissitude/observability/logger";
import type { Logger } from "@vicissitude/shared/types";

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

function allOutput(captures: { calls: string[] }[]): string[] {
	return captures.flatMap((c) => c.calls);
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

	// ─── Logger インターフェース準拠 ────────────────────────────

	it("Logger 型に代入可能である", () => {
		const logger: Logger = new ConsoleLogger();
		expect(logger).toBeDefined();
	});

	// ─── ログレベルフィルタリング ────────────────────────────────

	describe("ログレベルフィルタリング", () => {
		it("info レベルで debug() は出力されない", () => {
			setup();
			const logger = new ConsoleLogger("info");
			logger.debug("should not appear");

			expect(allOutput([stdoutCapture, stderrCapture])).toHaveLength(0);
		});

		it("debug レベルで debug() が出力される", () => {
			setup();
			const logger = new ConsoleLogger("debug");
			logger.debug("visible");

			const output = allOutput([stdoutCapture, stderrCapture]);
			expect(output.length).toBeGreaterThanOrEqual(1);
			expect(output.join("")).toContain("visible");
		});

		it("info レベルで info() が出力される", () => {
			setup();
			const logger = new ConsoleLogger("info");
			logger.info("info message");

			const output = allOutput([stdoutCapture, stderrCapture]);
			expect(output.length).toBeGreaterThanOrEqual(1);
			expect(output.join("")).toContain("info message");
		});

		it("info レベルで warn() が出力される", () => {
			setup();
			const logger = new ConsoleLogger("info");
			logger.warn("warn message");

			const output = allOutput([stdoutCapture, stderrCapture]);
			expect(output.length).toBeGreaterThanOrEqual(1);
			expect(output.join("")).toContain("warn message");
		});

		it("info レベルで error() が出力される", () => {
			setup();
			const logger = new ConsoleLogger("info");
			logger.error("error message");

			const output = allOutput([stdoutCapture, stderrCapture]);
			expect(output.length).toBeGreaterThanOrEqual(1);
			expect(output.join("")).toContain("error message");
		});

		it("デフォルトレベルでは debug() が抑制される", () => {
			setup();
			const logger = new ConsoleLogger();
			logger.debug("hidden");

			expect(allOutput([stdoutCapture, stderrCapture])).toHaveLength(0);
		});
	});

	// ─── メッセージの保存 ────────────────────────────────────────

	it("出力にメッセージ文字列が含まれる", () => {
		setup();
		const logger = new ConsoleLogger();
		logger.info("unique-test-message-12345");

		const output = allOutput([stdoutCapture, stderrCapture]).join("");
		expect(output).toContain("unique-test-message-12345");
	});

	// ─── extra 引数の格納 ────────────────────────────────────────

	describe("extra 引数の格納", () => {
		it("単一オブジェクト引数が extra フィールドに格納される", () => {
			setup();
			const logger = new ConsoleLogger();
			logger.info("with data", { key: "value" });

			const output = allOutput([stdoutCapture, stderrCapture]).join("");
			const entry = JSON.parse(output);
			expect(entry.extra).toEqual({ key: "value" });
		});

		it("複数引数が extra フィールドに配列として格納される", () => {
			setup();
			const logger = new ConsoleLogger();
			logger.info("multi", "a", 42);

			const output = allOutput([stdoutCapture, stderrCapture]).join("");
			const entry = JSON.parse(output);
			expect(entry.extra).toEqual(["a", 42]);
		});

		it("引数なしの場合 extra フィールドが存在しない", () => {
			setup();
			const logger = new ConsoleLogger();
			logger.info("no extra");

			const output = allOutput([stdoutCapture, stderrCapture]).join("");
			const entry = JSON.parse(output);
			expect(entry.extra).toBeUndefined();
		});
	});
});
