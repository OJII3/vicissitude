import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { wrapServerWithMetrics } from "./tool-metrics.ts";

type Handler = (...args: unknown[]) => unknown;

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
	test("ハンドラ呼び出しでカウンタがインクリメントされる", () => {
		const counts = new Map<string, number>();
		const { server, handlers } = createFakeServer();
		const wrapped = wrapServerWithMetrics(server, counts);

		const calls: string[] = [];
		wrapped.registerTool("my_tool", { description: "x" }, () => {
			calls.push("called");
			return { content: [{ type: "text" as const, text: "ok" }] };
		});

		expect(counts.get("my_tool")).toBeUndefined();

		call(handlers, "my_tool", {});
		call(handlers, "my_tool", {});
		call(handlers, "my_tool", {});

		expect(counts.get("my_tool")).toBe(3);
		expect(calls).toHaveLength(3);
	});

	test("registerTool 以外のプロパティはそのまま透過する", () => {
		const counts = new Map<string, number>();
		const { server } = createFakeServer();
		Object.defineProperty(server, "name", { value: "test-name", configurable: true });
		const wrapped = wrapServerWithMetrics(server, counts);

		expect((wrapped as unknown as { name: string }).name).toBe("test-name");
	});

	test("異なるツール名は独立してカウントされる", () => {
		const counts = new Map<string, number>();
		const { server, handlers } = createFakeServer();
		const wrapped = wrapServerWithMetrics(server, counts);

		wrapped.registerTool("tool_a", { description: "a" }, () => ({
			content: [{ type: "text" as const, text: "" }],
		}));
		wrapped.registerTool("tool_b", { description: "b" }, () => ({
			content: [{ type: "text" as const, text: "" }],
		}));

		call(handlers, "tool_a", {});
		call(handlers, "tool_a", {});
		call(handlers, "tool_b", {});

		expect(counts.get("tool_a")).toBe(2);
		expect(counts.get("tool_b")).toBe(1);
	});
});
