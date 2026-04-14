/* oxlint-disable no-non-null-assertion -- test helpers */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ToolHandler = (args: Record<string, unknown>) => unknown;
export type ToolResult = { content: Array<{ type: string; text: string }> };

/**
 * registerTool 呼び出しをキャプチャする fakeServer を作成し、
 * toolDescriptions に登録済みツール情報を保持する。
 */
export function createFakeServer(): {
	server: McpServer;
	tools: Map<string, ToolHandler>;
	toolDescriptions: Map<string, string | undefined>;
} {
	const tools = new Map<string, ToolHandler>();
	const toolDescriptions = new Map<string, string | undefined>();

	const fakeServer = {
		registerTool(name: string, config: { description?: string }, handler: ToolHandler) {
			tools.set(name, handler);
			toolDescriptions.set(name, config.description);
		},
	} as unknown as McpServer;

	return { server: fakeServer, tools, toolDescriptions };
}

/**
 * fakeServer にダミーツールを registerTool 経由で登録する。
 * spec テストが内部プロパティに直接アクセスしないようにする。
 */
export function registerDummyTool(server: McpServer, name: string, description?: string): void {
	(
		server as unknown as {
			registerTool: (n: string, c: { description?: string }, h: ToolHandler) => void;
		}
	).registerTool(name, { description }, () => ({ content: [] }));
}
