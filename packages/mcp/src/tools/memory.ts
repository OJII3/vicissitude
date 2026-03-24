import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMemoryTools(_server: McpServer): void {
	// Memory MCP tools have been removed.
	// - SOUL.md is now part of AGENTS.md (always loaded in context)
	// - MEMORY.md and LESSONS.md are abolished (learning goes to LTM)
	// - Guild-specific SERVER.md is loaded by context-builder automatically
}
