/* oxlint-disable no-non-null-assertion, no-explicit-any -- test assertions & fake server casting */
import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMetaTools } from "@vicissitude/mcp/tools/meta";

// ─── Types ───────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => unknown;
type ToolResult = { content: Array<{ type: string; text: string }> };

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * registerTool 呼び出しをキャプチャする fakeServer を作成し、
 * _registeredTools に登録済みツール情報を保持する。
 */
function createFakeServer(): {
	server: McpServer;
	tools: Map<string, ToolHandler>;
} {
	const tools = new Map<string, ToolHandler>();

	// _registeredTools は list_tools ハンドラが参照する内部プロパティ
	const registeredTools: Record<string, { description?: string }> = {};

	const fakeServer = {
		_registeredTools: registeredTools,
		registerTool(name: string, config: { description?: string }, handler: ToolHandler) {
			tools.set(name, handler);
			registeredTools[name] = { description: config.description };
		},
	} as unknown as McpServer;

	return { server: fakeServer, tools };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("registerMetaTools", () => {
	test("list_tools ツールが登録される", () => {
		const { server, tools } = createFakeServer();
		registerMetaTools(server);

		expect(tools.has("list_tools")).toBe(true);
	});

	test("list_tools 以外のツールは登録しない", () => {
		const { server, tools } = createFakeServer();
		registerMetaTools(server);

		expect(tools.size).toBe(1);
	});
});

describe("list_tools", () => {
	test("登録済みツールの name と description を返す", async () => {
		const { server, tools } = createFakeServer();

		// 他のツールをあらかじめ登録
		(server as any)._registeredTools["send_message"] = {
			description: "Send a message to a Discord channel",
		};
		(server as any)._registeredTools["read_messages"] = {
			description: "Read recent messages from a Discord channel",
		};

		registerMetaTools(server);
		const listTools = tools.get("list_tools")!;

		const result = (await listTools({})) as ToolResult;

		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("text");

		const text = result.content[0]!.text;
		expect(text).toContain("send_message");
		expect(text).toContain("Send a message to a Discord channel");
		expect(text).toContain("read_messages");
		expect(text).toContain("Read recent messages from a Discord channel");
	});

	test("list_tools 自身は一覧から除外される", async () => {
		const { server, tools } = createFakeServer();

		(server as any)._registeredTools["add_reaction"] = {
			description: "Add a reaction emoji",
		};

		registerMetaTools(server);
		const listTools = tools.get("list_tools")!;

		const result = (await listTools({})) as ToolResult;
		const text = result.content[0]!.text;

		expect(text).toContain("add_reaction");
		expect(text).not.toContain("list_tools");
	});

	test("ツールが0件（list_tools 除外後）の場合でもエラーにならない", async () => {
		const { server, tools } = createFakeServer();
		registerMetaTools(server);
		const listTools = tools.get("list_tools")!;

		const result = (await listTools({})) as ToolResult;

		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("text");
	});

	test("返却形式は { content: [{ type: 'text', text: string }] } である", async () => {
		const { server, tools } = createFakeServer();

		(server as any)._registeredTools["some_tool"] = {
			description: "A tool",
		};

		registerMetaTools(server);
		const listTools = tools.get("list_tools")!;

		const result = (await listTools({})) as ToolResult;

		expect(result).toHaveProperty("content");
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: expect.any(String),
		});
	});

	test("description が未定義のツールも一覧に含まれる", async () => {
		const { server, tools } = createFakeServer();

		(server as any)._registeredTools["no_desc_tool"] = {};

		registerMetaTools(server);
		const listTools = tools.get("list_tools")!;

		const result = (await listTools({})) as ToolResult;
		const text = result.content[0]!.text;

		expect(text).toContain("no_desc_tool");
	});
});
