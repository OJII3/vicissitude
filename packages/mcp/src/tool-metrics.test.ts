import { type mock, describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { METRIC } from "@vicissitude/observability/metrics";
import { createMockMetrics } from "@vicissitude/shared/test-helpers";
import type { MetricsCollector } from "@vicissitude/shared/types";

import { wrapServerWithMetrics } from "./tool-metrics.ts";

type Handler = (...args: unknown[]) => unknown;
type MockMetrics = MetricsCollector & { incrementCounter: ReturnType<typeof mock> };

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

describe("wrapServerWithMetrics", () => {
	test("ハンドラ呼び出しで incrementCounter が呼ばれる", () => {
		const metrics = createMockMetrics() as MockMetrics;
		const { server, handlers } = createFakeServer();
		const wrapped = wrapServerWithMetrics(server, { metrics });

		const calls: string[] = [];
		wrapped.registerTool("my_tool", { description: "x" }, () => {
			calls.push("called");
			return { content: [{ type: "text" as const, text: "ok" }] };
		});

		call(handlers, "my_tool", {});
		call(handlers, "my_tool", {});
		call(handlers, "my_tool", {});

		expect(metrics.incrementCounter).toHaveBeenCalledTimes(3);
		expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
			tool: "my_tool",
			outcome: "success",
		});
		expect(calls).toHaveLength(3);
	});

	test("registerTool 以外のプロパティはそのまま透過する", () => {
		const metrics = createMockMetrics() as MockMetrics;
		const { server } = createFakeServer();
		Object.defineProperty(server, "name", { value: "test-name", configurable: true });
		const wrapped = wrapServerWithMetrics(server, { metrics });

		expect((wrapped as unknown as { name: string }).name).toBe("test-name");
	});

	test("異なるツール名は独立してカウントされる", () => {
		const metrics = createMockMetrics() as MockMetrics;
		const { server, handlers } = createFakeServer();
		const wrapped = wrapServerWithMetrics(server, { metrics });

		wrapped.registerTool("tool_a", { description: "a" }, () => ({
			content: [{ type: "text" as const, text: "" }],
		}));
		wrapped.registerTool("tool_b", { description: "b" }, () => ({
			content: [{ type: "text" as const, text: "" }],
		}));

		call(handlers, "tool_a", {});
		call(handlers, "tool_a", {});
		call(handlers, "tool_b", {});

		expect(metrics.incrementCounter).toHaveBeenCalledTimes(3);
		expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
			tool: "tool_a",
			outcome: "success",
		});
		expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.MCP_TOOL_CALLS, {
			tool: "tool_b",
			outcome: "success",
		});
	});
});
