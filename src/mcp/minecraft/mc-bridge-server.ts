import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { closeDb, createDb } from "../../store/db.ts";
import { registerMinecraftBridgeTools } from "../tools/mc-bridge-minecraft.ts";
import { registerMcMemoryTools } from "../tools/mc-memory.ts";

// --- Configuration from environment ---

const root = process.env.APP_ROOT ?? resolve(import.meta.dirname, "../../..");
const DATA_DIR = process.env.DATA_DIR ?? resolve(root, "data");

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
