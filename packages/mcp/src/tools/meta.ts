import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolDescriptionMap = Map<string, string | undefined>;

interface RegisterToolLike {
	registerTool(name: string, config: { description?: string }, handler: unknown): unknown;
}

export function createToolDescriptionRecorder(
	server: McpServer,
	toolDescriptions: ToolDescriptionMap = new Map(),
): { server: McpServer; toolDescriptions: ToolDescriptionMap } {
	const delegate = server as unknown as RegisterToolLike;
	const recordingServer = {
		registerTool(name: string, config: { description?: string }, handler: unknown): unknown {
			toolDescriptions.set(name, config.description);
			return delegate.registerTool(name, config, handler);
		},
	} as unknown as McpServer;

	return { server: recordingServer, toolDescriptions };
}

export function registerMetaTools(
	server: McpServer,
	toolDescriptions: ReadonlyMap<string, string | undefined>,
): void {
	server.registerTool(
		"list_tools",
		{
			description: "List all available tools with their descriptions",
		},
		() => {
			const entries = [...toolDescriptions.entries()]
				.filter(([name]) => name !== "list_tools")
				.map(([name, desc]) => {
					return desc ? `${name}: ${desc}` : name;
				});
			return { content: [{ type: "text" as const, text: entries.join("\n") }] };
		},
	);
}
