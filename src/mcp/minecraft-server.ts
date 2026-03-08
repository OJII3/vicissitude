import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mineflayer from "mineflayer";
import pathfinder from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { z } from "zod";

import { registerActionTools } from "./minecraft-actions.ts";
import {
	IMPORTANCE_ORDER,
	getEquipment,
	getInventorySummary,
	getNearbyEntities,
	getTimePeriod,
	getWeather,
} from "./minecraft-bot-queries.ts";
import type { ActionState, Importance } from "./minecraft-bot-queries.ts";
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
	b.quit();
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

// ── Startup ──────────────────────────────────────────────────────────────────
bot = createBot();

const transport = new StdioServerTransport();
await server.connect(transport);

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(): void {
	shuttingDown = true;
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
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
