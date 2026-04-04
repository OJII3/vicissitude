import { type mock, describe, expect, it } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapServerWithMetrics } from "@vicissitude/mcp/tool-metrics";
import { METRIC } from "@vicissitude/observability/metrics";
import { createMockLogger, createMockMetrics } from "@vicissitude/shared/test-helpers";
import type { MetricsCollector } from "@vicissitude/shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => unknown;
type MockMetrics = MetricsCollector & { incrementCounter: ReturnType<typeof mock> };

/** registerTool だけを持つ最小限の McpServer フェイク */
function createFakeServer(): {
	server: McpServer;
	handlers: Map<string, Handler>;
} {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool(name: string, _config: unknown, cb: Handler) {
			handlers.set(name, cb);
		},
	} as unknown as McpServer;
	return { server, handlers };
}

function call(handlers: Map<string, Handler>, name: string, ...args: unknown[]): unknown {
	const h = handlers.get(name);
	if (!h) throw new Error(`Handler "${name}" not registered`);
	return h(...args);
}

function callAsync(
	handlers: Map<string, Handler>,
	name: string,
	...args: unknown[]
): Promise<unknown> {
	return call(handlers, name, ...args) as Promise<unknown>;
}

/** async ハンドラのスタブ: Promise.reject を返す（require-await 回避） */
function rejectWith(err: Error): () => Promise<never> {
	// oxlint-disable-next-line no-promise-in-callback -- テスト用スタブ
	return () => Promise.reject(err);
}

/** async ハンドラのスタブ: Promise.resolve を返す（require-await 回避） */
function resolveWith<T>(value: T): () => Promise<T> {
	return () => Promise.resolve(value);
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe("wrapServerWithMetrics", () => {
	// -----------------------------------------------------------------------
	// 1. 成功時: incrementCounter が outcome: "success" で呼ばれる
	// -----------------------------------------------------------------------
	describe("成功時", () => {
		it("同期ハンドラが成功したら incrementCounter が success ラベルで呼ばれる", () => {
			const metrics = createMockMetrics() as MockMetrics;
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics });

			wrapped.registerTool("ping", { description: "ping" }, () => ({
				content: [{ type: "text" as const, text: "pong" }],
			}));

			call(handlers, "ping", {});
			call(handlers, "ping", {});

			expect(metrics.incrementCounter).toHaveBeenCalledTimes(2);
			expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
				tool: "ping",
				outcome: "success",
			});
		});

		it("非同期ハンドラが成功したら incrementCounter が success ラベルで呼ばれる", async () => {
			const metrics = createMockMetrics() as MockMetrics;
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics });

			wrapped.registerTool(
				"async_ping",
				{ description: "async" },
				resolveWith({ content: [{ type: "text" as const, text: "pong" }] }),
			);

			await callAsync(handlers, "async_ping", {});

			expect(metrics.incrementCounter).toHaveBeenCalledTimes(1);
			expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
				tool: "async_ping",
				outcome: "success",
			});
		});
	});

	// -----------------------------------------------------------------------
	// 2. 同期エラー時
	// -----------------------------------------------------------------------
	describe("同期エラー時", () => {
		it("incrementCounter が error ラベルで呼ばれる", () => {
			const metrics = createMockMetrics() as MockMetrics;
			const logger = createMockLogger();
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics, logger });

			wrapped.registerTool("fail_tool", { description: "fail" }, () => {
				throw new Error("boom");
			});

			expect(() => call(handlers, "fail_tool", {})).toThrow("boom");
			expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
				tool: "fail_tool",
				outcome: "error",
			});
		});

		it("logger.error() がツール名とエラーメッセージを含んで呼ばれる", () => {
			const metrics = createMockMetrics() as MockMetrics;
			const logger = createMockLogger();
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics, logger });

			wrapped.registerTool("fail_tool", { description: "fail" }, () => {
				throw new Error("sync boom");
			});

			expect(() => call(handlers, "fail_tool", {})).toThrow();

			const errorCalls = (logger.error as ReturnType<typeof mock>).mock.calls;
			expect(errorCalls.length).toBeGreaterThanOrEqual(1);
			const logMessage = String(errorCalls[0]);
			expect(logMessage).toContain("fail_tool");
			expect(logMessage).toContain("sync boom");
		});

		it("エラーが re-throw される", () => {
			const metrics = createMockMetrics() as MockMetrics;
			const logger = createMockLogger();
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics, logger });

			const original = new Error("must propagate");
			wrapped.registerTool("rethrow_tool", { description: "x" }, () => {
				throw original;
			});

			expect(() => call(handlers, "rethrow_tool", {})).toThrow(original);
		});
	});

	// -----------------------------------------------------------------------
	// 3. 非同期エラー時 (Promise.reject)
	// -----------------------------------------------------------------------
	describe("非同期エラー時", () => {
		it("incrementCounter が error ラベルで呼ばれる", async () => {
			const metrics = createMockMetrics() as MockMetrics;
			const logger = createMockLogger();
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics, logger });

			wrapped.registerTool(
				"async_fail",
				{ description: "fail" },
				rejectWith(new Error("async boom")),
			);

			// oxlint-disable-next-line await-thenable -- Bun の expect().rejects.toThrow() は実行時 Promise
			await expect(callAsync(handlers, "async_fail", {})).rejects.toThrow("async boom");
			expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
				tool: "async_fail",
				outcome: "error",
			});
		});

		it("logger.error() がツール名とエラーメッセージを含んで呼ばれる", async () => {
			const metrics = createMockMetrics() as MockMetrics;
			const logger = createMockLogger();
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics, logger });

			wrapped.registerTool(
				"async_fail",
				{ description: "fail" },
				rejectWith(new Error("async kaboom")),
			);

			// oxlint-disable-next-line await-thenable -- Bun の expect().rejects.toThrow() は実行時 Promise
			await expect(callAsync(handlers, "async_fail", {})).rejects.toThrow();

			const errorCalls = (logger.error as ReturnType<typeof mock>).mock.calls;
			expect(errorCalls.length).toBeGreaterThanOrEqual(1);
			const logMessage = String(errorCalls[0]);
			expect(logMessage).toContain("async_fail");
			expect(logMessage).toContain("async kaboom");
		});

		it("エラーが re-throw される (rejection)", async () => {
			const metrics = createMockMetrics() as MockMetrics;
			const logger = createMockLogger();
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics, logger });

			const original = new Error("must propagate async");
			wrapped.registerTool("async_rethrow", { description: "x" }, rejectWith(original));

			// oxlint-disable-next-line await-thenable -- Bun の expect().rejects.toThrow() は実行時 Promise
			await expect(callAsync(handlers, "async_rethrow", {})).rejects.toThrow(original);
		});
	});

	// -----------------------------------------------------------------------
	// 4. logger 省略時
	// -----------------------------------------------------------------------
	describe("logger 省略時", () => {
		it("エラー時も incrementCounter が呼ばれる", () => {
			const metrics = createMockMetrics() as MockMetrics;
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics });

			wrapped.registerTool("no_logger", { description: "x" }, () => {
				throw new Error("no logger");
			});

			expect(() => call(handlers, "no_logger", {})).toThrow("no logger");
			expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
				tool: "no_logger",
				outcome: "error",
			});
		});

		it("エラーが re-throw される", () => {
			const metrics = createMockMetrics() as MockMetrics;
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics });

			const original = new Error("should propagate");
			wrapped.registerTool("no_logger_rethrow", { description: "x" }, () => {
				throw original;
			});

			expect(() => call(handlers, "no_logger_rethrow", {})).toThrow(original);
		});

		it("非同期エラーでも incrementCounter が呼ばれ re-throw される", async () => {
			const metrics = createMockMetrics() as MockMetrics;
			const { server, handlers } = createFakeServer();
			const wrapped = wrapServerWithMetrics(server, { metrics });

			wrapped.registerTool(
				"no_logger_async",
				{ description: "x" },
				rejectWith(new Error("async no logger")),
			);

			// oxlint-disable-next-line await-thenable -- Bun の expect().rejects.toThrow() は実行時 Promise
			await expect(callAsync(handlers, "no_logger_async", {})).rejects.toThrow("async no logger");
			expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
				tool: "no_logger_async",
				outcome: "error",
			});
		});
	});
});
