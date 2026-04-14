/* oxlint-disable no-non-null-assertion -- test assertions */
import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerMetaTools } from "./meta";
import { createFakeServer, type ToolHandler, type ToolResult } from "./meta-test-helpers";

// ─── Helpers ─────────────────────────────────────────────────────

function callListTools(
	server: McpServer,
	tools: Map<string, ToolHandler>,
	toolDescriptions: Map<string, string | undefined>,
): ToolResult {
	registerMetaTools(server, toolDescriptions);
	const handler = tools.get("list_tools")!;
	return handler({}) as ToolResult;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("list_tools 内部フォーマット", () => {
	test("各ツールは改行で区切られる", () => {
		const { server, tools, toolDescriptions } = createFakeServer();
		toolDescriptions.set("tool_a", "Desc A");
		toolDescriptions.set("tool_b", "Desc B");

		const result = callListTools(server, tools, toolDescriptions);
		const lines = result.content[0]!.text.split("\n");

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("tool_a: Desc A");
		expect(lines[1]).toBe("tool_b: Desc B");
	});

	test("description が空文字列の場合は name のみ出力される", () => {
		const { server, tools, toolDescriptions } = createFakeServer();
		toolDescriptions.set("empty_desc", "");

		const result = callListTools(server, tools, toolDescriptions);

		// 空文字列は falsy なので `desc ? ... : name` で name のみになる
		expect(result.content[0]!.text).toBe("empty_desc");
	});

	test("description に改行を含むツールはそのまま出力される", () => {
		const { server, tools, toolDescriptions } = createFakeServer();
		toolDescriptions.set("multi_line", "Line 1\nLine 2");

		const result = callListTools(server, tools, toolDescriptions);
		const text = result.content[0]!.text;

		expect(text).toBe("multi_line: Line 1\nLine 2");
	});

	test("description にマルチバイト文字を含むツールが正しくフォーマットされる", () => {
		const { server, tools, toolDescriptions } = createFakeServer();
		toolDescriptions.set("greet", "挨拶メッセージを送信する");

		const result = callListTools(server, tools, toolDescriptions);

		expect(result.content[0]!.text).toBe("greet: 挨拶メッセージを送信する");
	});

	test("ツール名にスペースや特殊文字が含まれる場合もそのまま出力される", () => {
		const { server, tools, toolDescriptions } = createFakeServer();
		toolDescriptions.set("my tool!@#", "Special");

		const result = callListTools(server, tools, toolDescriptions);

		expect(result.content[0]!.text).toBe("my tool!@#: Special");
	});

	test("0件の場合は空文字列を返す", () => {
		const { server, tools, toolDescriptions } = createFakeServer();

		const result = callListTools(server, tools, toolDescriptions);

		expect(result.content[0]!.text).toBe("");
	});
});

describe("list_tools 大量ツール", () => {
	test("100個のツールが登録されていても全て一覧に含まれる", () => {
		const { server, tools, toolDescriptions } = createFakeServer();

		for (let i = 0; i < 100; i++) {
			toolDescriptions.set(`tool_${i}`, `Description ${i}`);
		}

		const result = callListTools(server, tools, toolDescriptions);
		const lines = result.content[0]!.text.split("\n");

		expect(lines).toHaveLength(100);
		for (let i = 0; i < 100; i++) {
			expect(lines).toContainEqual(`tool_${i}: Description ${i}`);
		}
	});
});

describe("list_tools description 境界値", () => {
	test("description が undefined のツールは name のみ出力される", () => {
		const { server, tools, toolDescriptions } = createFakeServer();
		toolDescriptions.set("no_desc", undefined);

		const result = callListTools(server, tools, toolDescriptions);

		expect(result.content[0]!.text).toBe("no_desc");
	});

	test("description と undefined が混在する場合のフォーマット", () => {
		const { server, tools, toolDescriptions } = createFakeServer();
		toolDescriptions.set("with_desc", "Has desc");
		toolDescriptions.set("without_desc", undefined);

		const result = callListTools(server, tools, toolDescriptions);
		const text = result.content[0]!.text;

		expect(text).toContain("with_desc: Has desc");
		expect(text).toContain("without_desc");
		// without_desc の行にコロンが含まれないことを確認
		const withoutDescLine = text.split("\n").find((l) => l.startsWith("without_desc"));
		expect(withoutDescLine).toBe("without_desc");
	});
});
