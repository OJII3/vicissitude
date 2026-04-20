import { afterEach, beforeEach, describe, expect, it } from "bun:test";

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
			const logger = new ConsoleLogger({ level: "info" });
			logger.debug("should not appear");

			expect(output()).toBe("");
		});

		it("debug レベルで debug() が出力される", () => {
			const logger = new ConsoleLogger({ level: "debug" });
			logger.debug("visible");

			expect(output()).toContain("visible");
		});

		it("info レベルで info() が出力される", () => {
			const logger = new ConsoleLogger({ level: "info" });
			logger.info("info message");

			expect(output()).toContain("info message");
		});

		it("info レベルで warn() が出力される", () => {
			const logger = new ConsoleLogger({ level: "info" });
			logger.warn("warn message");

			expect(output()).toContain("warn message");
		});

		it("info レベルで error() が出力される", () => {
			const logger = new ConsoleLogger({ level: "info" });
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

	// ─── child logger ───────────────────────────────────────────────

	describe("child logger", () => {
		it("bindings を全ログに付与する", () => {
			const logger = new ConsoleLogger();
			const child = logger.child({ correlationId: "test-correlation-id" });
			child.info("child message");

			const out = output();
			expect(out).toContain("child message");
			expect(out).toContain("test-correlation-id");
		});

		it("ログレベルを親から引き継ぐ", () => {
			const logger = new ConsoleLogger({ level: "info" });
			const child = logger.child({ correlationId: "id-1" });
			child.debug("should not appear");

			expect(output()).toBe("");
		});

		it("Logger interface を満たす", () => {
			const logger = new ConsoleLogger();
			const child = logger.child({ correlationId: "id-2" });

			// Logger interface の全メソッドが存在する
			expect(typeof child.debug).toBe("function");
			expect(typeof child.info).toBe("function");
			expect(typeof child.error).toBe("function");
			expect(typeof child.warn).toBe("function");
			expect(typeof child.child).toBe("function");

			// 型レベルでも Logger を満たすことを確認
			const _: Logger = child;
			expect(_).toBeDefined();
		});

		it("ネストした child logger が全 bindings をマージする", () => {
			const logger = new ConsoleLogger();
			const nested = logger.child({ a: 1 }).child({ b: 2 });
			nested.info("nested message");

			const out = output();
			expect(out).toContain("nested message");
			expect(out).toContain("1");
			expect(out).toContain("2");
		});
	});
});
