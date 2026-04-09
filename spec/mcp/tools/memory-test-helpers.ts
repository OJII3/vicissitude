import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryDeps } from "@vicissitude/mcp/tools/memory";
import { registerMemoryTools } from "@vicissitude/mcp/tools/memory";
import type { MemoryNamespace } from "@vicissitude/memory/namespace";

// ─── captureMemoryTools ──────────────────────────────────────────

/** registerMemoryTools で登録されたツールの name → inputSchema マップを取得する */
export function captureMemoryTools(boundNamespace?: MemoryNamespace): {
	schemas: Map<string, Record<string, unknown>>;
} {
	const schemas = new Map<string, Record<string, unknown>>();

	const fakeServer = {
		registerTool(
			name: string,
			config: { inputSchema: Record<string, unknown> },
			_handler: unknown,
		) {
			schemas.set(name, config.inputSchema);
		},
	} as unknown as McpServer;

	const fakeDeps: MemoryDeps = {
		getOrCreateMemory: () => {
			throw new Error("should not be called in schema capture");
		},
	};

	registerMemoryTools(fakeServer, fakeDeps, boundNamespace);

	return { schemas };
}

// ─── ToolHandler type ────────────────────────────────────────────

/** MCP tool handler の戻り値型 */
export interface ToolResult {
	content: { type: string; text: string }[];
	isError?: boolean;
}

// oxlint-disable-next-line no-explicit-any -- MCP handler の引数型は動的
type ToolHandler = (args: any) => Promise<ToolResult>;

// ─── captureMemoryToolHandlers ───────────────────────────────────

/** registerMemoryTools で登録されたツールのハンドラも含めてキャプチャする */
export function captureMemoryToolHandlers(
	deps: MemoryDeps,
	boundNamespace?: MemoryNamespace,
): {
	schemas: Map<string, Record<string, unknown>>;
	handlers: Map<string, ToolHandler>;
} {
	const schemas = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, ToolHandler>();

	const fakeServer = {
		registerTool(
			name: string,
			config: { inputSchema: Record<string, unknown> },
			handler: ToolHandler,
		) {
			schemas.set(name, config.inputSchema);
			handlers.set(name, handler);
		},
	} as unknown as McpServer;

	registerMemoryTools(fakeServer, deps, boundNamespace);

	return { schemas, handlers };
}
