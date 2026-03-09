/* oxlint-disable max-lines -- standalone MCP server process, splitting would reduce readability */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import mineflayer from "mineflayer";
import pathfinder from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { z } from "zod";

import { registerActionTools } from "./minecraft-actions/index.ts";
import {
	IMPORTANCE_ORDER,
	getEquipment,
	getInventorySummary,
	getNearbyEntities,
	getTimePeriod,
	getWeather,
	type ActionState,
	type Importance,
} from "./minecraft-bot-queries.ts";
import { JobManager } from "./minecraft-job-manager.ts";
import { formatEvents, formatJobStatus, summarizeState } from "./minecraft-state-summary.ts";

// ── Environment ──────────────────────────────────────────────────────────────
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

// ── Event ring buffer ────────────────────────────────────────────────────────
interface BotEvent {
	timestamp: string;
	kind: string;
	description: string;
	importance: Importance;
}

const MAX_EVENTS = 100;
const events: BotEvent[] = [];

function pushEvent(kind: string, description: string, importance: Importance): void {
	events.push({ timestamp: new Date().toISOString(), kind, description, importance });
	if (events.length > MAX_EVENTS) events.shift();
}

// ── Action state ─────────────────────────────────────────────────────────────
const actionState: ActionState = { type: "idle" };

function setActionState(state: ActionState): void {
	actionState.type = state.type;
	actionState.target = state.target;
	actionState.jobId = state.jobId;
	actionState.progress = state.progress;
}

// ── Bot connection ───────────────────────────────────────────────────────────
let bot: mineflayer.Bot | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 60_000;
let shuttingDown = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let lastHealth = -1;
let lastFood = -1;
let lastTimePeriod = "";
let lastWeather = "";

function registerCoreEvents(b: mineflayer.Bot): void {
	b.once("spawn", () => {
		console.error(`[minecraft] Bot spawned as ${b.username} at ${b.entity.position}`);
		pushEvent("spawn", `Spawned at ${b.entity.position}`, "high");
		reconnectDelay = 1000;
	});
	b.on("death", () => pushEvent("death", "Bot died", "high"));
	b.on("health", () => {
		const h = Math.round(b.health);
		const f = Math.round(b.food);
		const healthDelta = Math.abs(h - lastHealth);
		const droppedToLow = h <= 5 && lastHealth > 5;
		if (lastHealth < 0 || healthDelta >= 5 || droppedToLow) {
			const importance: Importance = h <= 5 ? "medium" : "low";
			lastHealth = h;
			lastFood = f;
			pushEvent("health", `Health: ${String(h)}, Food: ${String(f)}`, importance);
		} else if (f !== lastFood) {
			lastHealth = h;
			lastFood = f;
		}
	});
	b.on("chat", (username: string, message: string) => {
		if (username !== b.username) pushEvent("chat", `<${username}> ${message}`, "medium");
	});
	b.on("kicked", (reason: string) => {
		console.error(`[minecraft] Kicked: ${reason}`);
		pushEvent("kicked", `Kicked: ${reason}`, "high");
	});
	b.on("entityHurt", (entity: Entity) => {
		if (entity === b.entity) pushEvent("damage", "Bot took damage", "medium");
	});
	b.on("end", (reason: string) => {
		console.error(`[minecraft] Disconnected: ${reason}`);
		pushEvent("disconnect", `Disconnected: ${reason}`, "high");
		if (!shuttingDown) scheduleReconnect();
	});
	b.on("error", (err: Error) => console.error(`[minecraft] Error: ${err.message}`));
}

function registerWorldEvents(b: mineflayer.Bot): void {
	b.on("playerJoined", (player: { username: string }) => {
		pushEvent("playerJoined", `${player.username} が参加`, "medium");
	});
	b.on("playerLeft", (player: { username: string }) => {
		pushEvent("playerLeft", `${player.username} が退出`, "medium");
	});
	b.on("time", () => {
		const timeOfDay = b.time?.timeOfDay;
		if (timeOfDay === undefined) return;
		const period = getTimePeriod(timeOfDay);
		if (period !== lastTimePeriod && lastTimePeriod !== "") {
			pushEvent("timeChange", `${period}になった`, "low");
		}
		lastTimePeriod = period;
	});
	b.on("rain", () => {
		const weather = getWeather(b);
		if (weather !== lastWeather && lastWeather !== "") {
			pushEvent("weatherChange", `天気が${weather}に変わった`, "low");
		}
		lastWeather = weather;
	});
}

function cleanupBot(b: mineflayer.Bot): void {
	b.removeAllListeners();
	if (typeof b.quit === "function") b.quit();
}

function createBot(): mineflayer.Bot {
	const b = mineflayer.createBot({
		host: MC_HOST,
		port: MC_PORT,
		username: MC_USERNAME,
		version: MC_VERSION,
		auth: "offline",
	});
	b.loadPlugin(pathfinder.pathfinder);
	registerCoreEvents(b);
	registerWorldEvents(b);
	return b;
}

function scheduleReconnect(): void {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	console.error(`[minecraft] Reconnecting in ${String(reconnectDelay)}ms...`);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		if (shuttingDown) return;
		if (bot) cleanupBot(bot);
		bot = createBot();
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// ── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
	name: "minecraft",
	version: "0.1.0",
});

server.tool("observe_state", "Minecraft ボットの現在の状態を自然言語要約で取得する", {}, () => {
	if (!bot || !bot.entity) {
		return { content: [{ type: "text", text: "ボット未接続" }] };
	}

	const pos = bot.entity.position;
	const timeOfDay = bot.time?.timeOfDay;
	const summary = summarizeState({
		position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
		health: bot.health,
		food: bot.food,
		timePeriod: timeOfDay === undefined ? "不明" : getTimePeriod(timeOfDay),
		weather: getWeather(bot),
		action: { ...actionState },
		nearbyEntities: getNearbyEntities(bot, 5),
		inventory: getInventorySummary(bot),
		equipment: getEquipment(bot),
		recentEvents: events.slice(-10),
	});

	return { content: [{ type: "text", text: summary }] };
});

server.tool(
	"get_recent_events",
	"Minecraft ボットの直近イベントログをテキスト形式で取得する",
	{
		limit: z
			.number()
			.min(1)
			.max(50)
			.default(10)
			.describe("取得するイベント数（デフォルト: 10、最大: 50）"),
		importance: z
			.enum(["low", "medium", "high"])
			.optional()
			.describe("最低重要度フィルタ（例: medium → medium 以上のみ）"),
	},
	({ limit, importance }) => {
		let filtered = events;
		if (importance) {
			const threshold = IMPORTANCE_ORDER[importance];
			filtered = events.filter((e) => IMPORTANCE_ORDER[e.importance] >= threshold);
		}
		const recent = filtered.slice(-limit);
		return { content: [{ type: "text", text: formatEvents(recent) }] };
	},
);

const jobManager = new JobManager(pushEvent, setActionState);

registerActionTools(server, () => bot, jobManager);

server.tool(
	"get_job_status",
	"現在のジョブ状態と直近のジョブ履歴を取得する",
	{
		limit: z
			.number()
			.min(1)
			.max(20)
			.default(5)
			.describe("取得するジョブ履歴数（デフォルト: 5、最大: 20）"),
	},
	({ limit }) => {
		const current = jobManager.getCurrentJob();
		const recent = jobManager.getRecentJobs(limit);
		const text = formatJobStatus(current, recent);
		return { content: [{ type: "text", text }] };
	},
);

server.tool(
	"take_screenshot",
	"ボット視点のスクリーンショットを撮影する（PNG形式）",
	{
		width: z.number().min(64).max(1920).default(512).describe("画像の幅（デフォルト: 512）"),
		height: z.number().min(64).max(1080).default(512).describe("画像の高さ（デフォルト: 512）"),
	},
	async ({ width, height }) => {
		if (!bot?.entity) {
			return { content: [{ type: "text" as const, text: "ボット未接続" }] };
		}
		try {
			const { takeScreenshot } = await import("./minecraft-screenshot.ts");
			const { filePath, base64 } = await takeScreenshot(bot, { width, height });
			return {
				content: [
					{ type: "text" as const, text: `スクリーンショットを保存しました: ${filePath}` },
					{ type: "image" as const, data: base64, mimeType: "image/png" },
				],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text" as const, text: `スクリーンショット失敗: ${message}` }] };
		}
	},
);

// ── HTTP Server ──────────────────────────────────────────────────────────────
bot = createBot();
const MC_MCP_PORT = Number(process.env.MC_MCP_PORT ?? "3001");
// 30 分
const SESSION_TTL_MS = 30 * 60 * 1000;
// 5 分ごとに掃除
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionEntry {
	transport: WebStandardStreamableHTTPServerTransport;
	lastAccess: number;
}
const sessions = new Map<string, SessionEntry>();

// 孤立セッションの定期クリーンアップ
const sessionCleanupTimer = setInterval(() => {
	const now = Date.now();
	for (const [id, entry] of sessions) {
		if (now - entry.lastAccess > SESSION_TTL_MS) {
			entry.transport.close().catch(() => {});
			sessions.delete(id);
		}
	}
}, SESSION_CLEANUP_INTERVAL_MS);

Bun.serve({
	port: MC_MCP_PORT,
	async fetch(req) {
		if (new URL(req.url).pathname !== "/mcp") return new Response("Not Found", { status: 404 });
		const sessionId = req.headers.get("mcp-session-id");
		const entry = sessionId ? sessions.get(sessionId) : undefined;
		if (entry) {
			entry.lastAccess = Date.now();
			return entry.transport.handleRequest(req);
		}
		if (req.method === "POST" && !sessionId) {
			const t = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => crypto.randomUUID(),
				onsessioninitialized: (id) => {
					sessions.set(id, { transport: t, lastAccess: Date.now() });
				},
				onsessionclosed: (id) => {
					sessions.delete(id);
				},
			});
			/* oxlint-disable-next-line prefer-add-event-listener -- SDK callback property */
			t.onclose = () => {
				const id = t.sessionId;
				if (id) sessions.delete(id);
			};
			await server.connect(t);
			return t.handleRequest(req);
		}
		return new Response("Bad Request", { status: 400 });
	},
});
console.error(`[minecraft] MCP server listening on port ${MC_MCP_PORT}`);

const shutdown = (): void => {
	shuttingDown = true;
	clearInterval(sessionCleanupTimer);
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (bot) {
		bot.quit();
		bot = null;
	}
	server.close().catch(() => {});
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
