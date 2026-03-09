import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createBotConnection } from "./bot-connection.ts";
import { createBotContext } from "./bot-context.ts";
import { startHttpServer } from "./http-server.ts";
import { JobManager } from "./job-manager.ts";
import { registerMinecraftTools } from "./mcp-tools.ts";

// ── Environment ──────────────────────────────────────────────────────────────
const MC_VIEWER_PORT = Number(process.env.MC_VIEWER_PORT ?? "3007");
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
const MC_MCP_PORT = Number(process.env.MC_MCP_PORT ?? "3001");

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

const server = new McpServer({ name: "minecraft", version: "0.1.0" });
const jobManager = new JobManager(ctx.pushEvent, ctx.setActionState);

registerMinecraftTools(server, ctx, jobManager, MC_VIEWER_PORT);

connection.start();
const { cleanupTimer } = startHttpServer(server, MC_MCP_PORT);

// ── Shutdown ─────────────────────────────────────────────────────────────────
const shutdown = (): void => {
	clearInterval(cleanupTimer);
	connection.shutdown();
	server.close().catch(() => {});
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) =>
	console.error("[minecraft] uncaughtException:", err.message),
);
process.on("unhandledRejection", (err) => console.error("[minecraft] unhandledRejection:", err));
