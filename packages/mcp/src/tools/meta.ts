import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
