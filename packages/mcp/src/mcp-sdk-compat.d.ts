import type { RegisteredTool, ToolAnnotations } from "@modelcontextprotocol/sdk/server/mcp.js";

declare module "@modelcontextprotocol/sdk/server/mcp.js" {
	interface McpServer {
		registerTool<Args extends object>(
			name: string,
			config: {
				title?: string;
				description?: string;
				inputSchema?: Record<string, unknown>;
				outputSchema?: Record<string, unknown>;
				annotations?: ToolAnnotations;
				_meta?: Record<string, unknown>;
			},
			cb: (args: Args, extra: unknown) => unknown,
		): RegisteredTool;
	}
}
