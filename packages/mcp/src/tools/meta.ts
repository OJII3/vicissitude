import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMetaTools(server: McpServer): void {
	server.registerTool(
		"list_tools",
		{
			description: "List all available tools with their descriptions",
		},
		() => {
			// oxlint-disable-next-line no-explicit-any -- McpServer._registeredTools は private だがランタイムでアクセス可能
			const registeredTools = (server as any)._registeredTools as Record<
				string,
				{ description?: string }
			>;
			const entries = Object.entries(registeredTools)
				.filter(([name]) => name !== "list_tools")
				.map(([name, info]) => {
					const desc = info.description;
					return desc ? `${name}: ${desc}` : name;
				});
			return { content: [{ type: "text" as const, text: entries.join("\n") }] };
		},
	);
}
