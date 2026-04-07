import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryDeps } from "@vicissitude/mcp/tools/memory";
import { registerMemoryTools } from "@vicissitude/mcp/tools/memory";
import type { MemoryNamespace } from "@vicissitude/memory/namespace";

// ─── Types ───────────────────────────────────────────────────────

export type ToolSchema = Record<string, unknown>;

// ─── captureMemoryTools ──────────────────────────────────────────

/** registerMemoryTools で登録されたツールの name → inputSchema マップを取得する */
export function captureMemoryTools(boundNamespace?: MemoryNamespace): {
	schemas: Map<string, ToolSchema>;
} {
	const schemas = new Map<string, ToolSchema>();

	const fakeServer = {
		registerTool(name: string, config: { inputSchema: ToolSchema }, _handler: unknown) {
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
