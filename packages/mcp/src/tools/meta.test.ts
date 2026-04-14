/* oxlint-disable no-non-null-assertion, no-explicit-any -- test assertions & fake server casting */
import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerMetaTools } from "./meta";

// ─── Types ───────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => unknown;
type ToolResult = { content: Array<{ type: string; text: string }> };

// ─── Helpers ─────────────────────────────────────────────────────

function createFakeServer(): {
	server: McpServer;
	tools: Map<string, ToolHandler>;
} {
	const tools = new Map<string, ToolHandler>();
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

function callListTools(server: McpServer, tools: Map<string, ToolHandler>): ToolResult {
	registerMetaTools(server);
	const handler = tools.get("list_tools")!;
	return handler({}) as ToolResult;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("list_tools 内部フォーマット", () => {
	test("各ツールは改行で区切られる", () => {
		const { server, tools } = createFakeServer();
		(server as any)._registeredTools["tool_a"] = { description: "Desc A" };
		(server as any)._registeredTools["tool_b"] = { description: "Desc B" };

		const result = callListTools(server, tools);
		const lines = result.content[0]!.text.split("\n");

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("tool_a: Desc A");
		expect(lines[1]).toBe("tool_b: Desc B");
	});

	test("description が空文字列の場合は name のみ出力される", () => {
		const { server, tools } = createFakeServer();
		(server as any)._registeredTools["empty_desc"] = { description: "" };

		const result = callListTools(server, tools);

		// 空文字列は falsy なので `desc ? ... : name` で name のみになる
		expect(result.content[0]!.text).toBe("empty_desc");
	});

	test("description に改行を含むツールはそのまま出力される", () => {
		const { server, tools } = createFakeServer();
		(server as any)._registeredTools["multi_line"] = {
			description: "Line 1\nLine 2",
		};

		const result = callListTools(server, tools);
		const text = result.content[0]!.text;

		expect(text).toBe("multi_line: Line 1\nLine 2");
	});

	test("description にマルチバイト文字を含むツールが正しくフォーマットされる", () => {
		const { server, tools } = createFakeServer();
		(server as any)._registeredTools["greet"] = {
			description: "挨拶メッセージを送信する",
		};

		const result = callListTools(server, tools);

		expect(result.content[0]!.text).toBe("greet: 挨拶メッセージを送信する");
	});

	test("ツール名にスペースや特殊文字が含まれる場合もそのまま出力される", () => {
		const { server, tools } = createFakeServer();
		(server as any)._registeredTools["my tool!@#"] = {
			description: "Special",
		};

		const result = callListTools(server, tools);

		expect(result.content[0]!.text).toBe("my tool!@#: Special");
	});

	test("0件の場合は空文字列を返す", () => {
		const { server, tools } = createFakeServer();

		const result = callListTools(server, tools);

		expect(result.content[0]!.text).toBe("");
	});
});

describe("list_tools 大量ツール", () => {
	test("100個のツールが登録されていても全て一覧に含まれる", () => {
		const { server, tools } = createFakeServer();

		for (let i = 0; i < 100; i++) {
			(server as any)._registeredTools[`tool_${i}`] = {
				description: `Description ${i}`,
			};
		}

		const result = callListTools(server, tools);
		const lines = result.content[0]!.text.split("\n");

		expect(lines).toHaveLength(100);
		for (let i = 0; i < 100; i++) {
			expect(lines).toContainEqual(`tool_${i}: Description ${i}`);
		}
	});
});

describe("list_tools description 境界値", () => {
	test("description が undefined のツールは name のみ出力される", () => {
		const { server, tools } = createFakeServer();
		(server as any)._registeredTools["no_desc"] = { description: undefined };

		const result = callListTools(server, tools);

		expect(result.content[0]!.text).toBe("no_desc");
	});

	test("description と undefined が混在する場合のフォーマット", () => {
		const { server, tools } = createFakeServer();
		(server as any)._registeredTools["with_desc"] = { description: "Has desc" };
		(server as any)._registeredTools["without_desc"] = {};

		const result = callListTools(server, tools);
		const text = result.content[0]!.text;

		expect(text).toContain("with_desc: Has desc");
		expect(text).toContain("without_desc");
		// without_desc の行にコロンが含まれないことを確認
		const withoutDescLine = text.split("\n").find((l) => l.startsWith("without_desc"));
		expect(withoutDescLine).toBe("without_desc");
	});
});
