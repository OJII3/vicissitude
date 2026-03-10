import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createBotConnection } from "./bot-connection.ts";
import { createBotContext } from "./bot-context.ts";
import { startHttpServer } from "./http-server.ts";
import { JobManager } from "./job-manager.ts";
import { registerMinecraftTools } from "./mcp-tools.ts";

// ── Environment ──────────────────────────────────────────────────────────────
const viewerPortRaw = Number(process.env.MC_VIEWER_PORT ?? "3007");
if (!Number.isInteger(viewerPortRaw) || viewerPortRaw < 1 || viewerPortRaw > 65535) {
	console.error("MC_VIEWER_PORT must be a valid port number (1-65535)");
	process.exit(1);
}
const MC_VIEWER_PORT = viewerPortRaw;
const MC_HOST = process.env.MC_HOST;
if (!MC_HOST) {
	console.error("MC_HOST is required");
	process.exit(1);
}
const portRaw = Number(process.env.MC_PORT ?? "25565");
if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
	console.error("MC_PORT must be a valid port number (1-65535)");
	process.exit(1);
}
const MC_PORT = portRaw;
const MC_USERNAME = process.env.MC_USERNAME ?? "fua";
const MC_VERSION = process.env.MC_VERSION ?? undefined;
const mcpPortRaw = Number(process.env.MC_MCP_PORT ?? "3001");
if (!Number.isInteger(mcpPortRaw) || mcpPortRaw < 1 || mcpPortRaw > 65535) {
	console.error("MC_MCP_PORT must be a valid port number (1-65535)");
	process.exit(1);
}
const MC_MCP_PORT = mcpPortRaw;

// ── Bootstrap ────────────────────────────────────────────────────────────────
const ctx = createBotContext();
const connection = createBotConnection(
	{
		host: MC_HOST,
		port: MC_PORT,
		username: MC_USERNAME,
		version: MC_VERSION,
		viewerPort: MC_VIEWER_PORT,
	},
	ctx,
);

const jobManager = new JobManager(ctx.pushEvent, ctx.setActionState);

function createServer(): McpServer {
	const server = new McpServer({ name: "minecraft", version: "0.1.0" });
	registerMinecraftTools(server, ctx, jobManager, MC_VIEWER_PORT);
	return server;
}

const { cleanupTimer, closeAllSessions } = startHttpServer(createServer, MC_MCP_PORT, "minecraft");
connection.start();

// ── Shutdown ─────────────────────────────────────────────────────────────────
const shutdown = (): void => {
	clearInterval(cleanupTimer);
	closeAllSessions();
	connection.shutdown();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) =>
	console.error("[minecraft] uncaughtException:", err.message),
);
process.on("unhandledRejection", (err) => console.error("[minecraft] unhandledRejection:", err));
