import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMinecraftBridgeTools } from "@vicissitude/mcp/tools/mc-bridge-minecraft";
import { registerMcMemoryTools } from "@vicissitude/mcp/tools/mc-memory";
import { APP_ROOT } from "@vicissitude/shared/config";
import { closeDb, createDb } from "@vicissitude/store/db";

// --- Configuration from environment ---

const DATA_DIR = process.env.DATA_DIR ?? resolve(APP_ROOT, "data");

// --- Drizzle DB ---

const db = createDb(DATA_DIR);

// --- MCP Server ---

const server = new McpServer({ name: "mc-bridge", version: "1.0.0" });

registerMinecraftBridgeTools(server, { db });
registerMcMemoryTools(server, { dataDir: resolve(DATA_DIR, "context/minecraft") });

// --- Graceful Shutdown ---

async function shutdown() {
	await server.close();
	closeDb(db);
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
