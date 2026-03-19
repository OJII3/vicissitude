/* oxlint-disable max-dependencies -- server entry requires auto-notifier + bridge DB dependencies */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { parseMcAuthMode } from "@vicissitude/shared/config";
import { createDb, closeDb } from "@vicissitude/store/db";

import { createAutoNotifier } from "./auto-notifier.ts";
import { createBotConnection } from "./bot-connection.ts";
import { createBotContext } from "./bot-context.ts";
import { startHttpServer } from "./http-server.ts";
import { JobManager } from "./job-manager.ts";
import { createMcMetrics } from "./mc-metrics.ts";
import { registerMinecraftTools } from "./mcp-tools.ts";

// ── Logger ───────────────────────────────────────────────────────────────────
const logger = new ConsoleLogger();

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
const MC_USERNAME = process.env.MC_USERNAME ?? "hua";
const MC_VERSION = process.env.MC_VERSION ?? undefined;
let MC_AUTH_MODE: ReturnType<typeof parseMcAuthMode>;
try {
	MC_AUTH_MODE = parseMcAuthMode(process.env.MC_AUTH_MODE ?? "offline");
} catch (e) {
	console.error((e as Error).message);
	process.exit(1);
}
const MC_PROFILES_FOLDER = process.env.MC_PROFILES_FOLDER;
if (MC_AUTH_MODE === "offline" && MC_PROFILES_FOLDER) {
	logger.warn(
		"[minecraft] MC_PROFILES_FOLDER is set but MC_AUTH_MODE is 'offline'; it will be ignored",
	);
}
const mcpPortRaw = Number(process.env.MC_MCP_PORT ?? "3001");
if (!Number.isInteger(mcpPortRaw) || mcpPortRaw < 1 || mcpPortRaw > 65535) {
	console.error("MC_MCP_PORT must be a valid port number (1-65535)");
	process.exit(1);
}
const MC_MCP_PORT = mcpPortRaw;
const DATA_DIR = process.env.DATA_DIR;

// ── Metrics ───────────────────────────────────────────────────────────────────
const { collector: mcCollector, server: mcMetricsServer } = createMcMetrics(logger);
mcMetricsServer.start();

// ── Bridge DB (auto-notification) ─────────────────────────────────────────────
const bridgeDb = DATA_DIR ? createDb(DATA_DIR) : undefined;
const autoNotifier = bridgeDb
	? createAutoNotifier(bridgeDb, { metrics: mcCollector, logger })
	: undefined;
if (!bridgeDb) {
	logger.warn("[minecraft] DATA_DIR not set; Discord auto-notifications disabled");
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
const ctx = createBotContext({
	metrics: mcCollector,
	urgentEventNotifier: (kind, description, importance) => {
		autoNotifier?.(kind, description, importance);
	},
});
const connection = createBotConnection(
	{
		host: MC_HOST,
		port: MC_PORT,
		username: MC_USERNAME,
		version: MC_VERSION,
		authMode: MC_AUTH_MODE,
		profilesFolder: MC_PROFILES_FOLDER,
		viewerPort: MC_VIEWER_PORT,
	},
	ctx,
	logger,
);

const jobManager = new JobManager(ctx.pushEvent, ctx.setActionState, mcCollector);

function createServer(): McpServer {
	const server = new McpServer({ name: "minecraft", version: "0.1.0" });
	registerMinecraftTools(server, ctx, jobManager, MC_VIEWER_PORT, {
		metrics: mcCollector,
		logger,
		stuckRecovery: {
			reconnect: () => connection.triggerReconnect(),
			onRecoverySuccess: () => {
				jobManager.resetStuckNotification();
			},
			cooldownMs: 300_000,
		},
	});
	return server;
}

const { cleanupTimer, closeAllSessions, stopServer } = startHttpServer(
	createServer,
	MC_MCP_PORT,
	"minecraft",
);
connection.start();

// ── Shutdown ─────────────────────────────────────────────────────────────────
const shutdown = (): void => {
	clearInterval(cleanupTimer);
	closeAllSessions();
	stopServer();
	mcMetricsServer.stop();
	connection.shutdown();
	if (bridgeDb) closeDb(bridgeDb);
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) =>
	logger.error("[minecraft] uncaughtException:", err.message),
);
process.on("unhandledRejection", (err) => logger.error("[minecraft] unhandledRejection:", err));
