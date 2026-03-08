import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mineflayer from "mineflayer";
import pathfinder from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { z } from "zod";

import { getTimePeriod } from "./minecraft-helpers.ts";

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
}

const MAX_EVENTS = 100;
const events: BotEvent[] = [];

function pushEvent(kind: string, description: string): void {
	events.push({ timestamp: new Date().toISOString(), kind, description });
	if (events.length > MAX_EVENTS) events.shift();
}

// ── Bot connection ───────────────────────────────────────────────────────────

let bot: mineflayer.Bot | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 60_000;
let shuttingDown = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let lastHealth = -1;
let lastFood = -1;

function registerBotEvents(b: mineflayer.Bot): void {
	b.once("spawn", () => {
		console.error(`[minecraft] Bot spawned as ${b.username} at ${b.entity.position}`);
		pushEvent("spawn", `Spawned at ${b.entity.position}`);
		reconnectDelay = 1000;
	});
	b.on("death", () => pushEvent("death", "Bot died"));
	b.on("health", () => {
		const h = Math.round(b.health);
		const f = Math.round(b.food);
		if (h !== lastHealth || f !== lastFood) {
			lastHealth = h;
			lastFood = f;
			pushEvent("health", `Health: ${String(h)}, Food: ${String(f)}`);
		}
	});
	b.on("chat", (username: string, message: string) => {
		if (username !== b.username) pushEvent("chat", `<${username}> ${message}`);
	});
	b.on("kicked", (reason: string) => {
		console.error(`[minecraft] Kicked: ${reason}`);
		pushEvent("kicked", `Kicked: ${reason}`);
	});
	b.on("entityHurt", (entity: Entity) => {
		if (entity === b.entity) pushEvent("damage", "Bot took damage");
	});
	b.on("end", (reason: string) => {
		console.error(`[minecraft] Disconnected: ${reason}`);
		pushEvent("disconnect", `Disconnected: ${reason}`);
		if (!shuttingDown) scheduleReconnect();
	});
	b.on("error", (err: Error) => console.error(`[minecraft] Error: ${err.message}`));
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
	registerBotEvents(b);
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWeather(b: mineflayer.Bot): string {
	if (b.thunderState > 0) return "雷雨";
	if (b.isRaining) return "雨";
	return "晴れ";
}

function getNearbyEntities(
	b: mineflayer.Bot,
	limit: number,
): { name: string; distance: number; type: string }[] {
	return Object.values(b.entities)
		.filter((e) => e !== b.entity && e.position)
		.map((e) => ({
			name: e.username ?? e.displayName ?? e.name ?? "unknown",
			distance: Math.round(e.position.distanceTo(b.entity.position)),
			type: e.type,
		}))
		.toSorted((x, y) => x.distance - y.distance)
		.slice(0, limit);
}

function getInventorySummary(b: mineflayer.Bot): {
	items: { name: string; count: number }[];
	emptySlots: number;
} {
	const items = b.inventory
		.items()
		.map((item) => ({ name: item.displayName ?? item.name, count: item.count }));
	const totalSlots = b.inventory.slots.length;
	const usedSlots = b.inventory.items().length;
	return { items, emptySlots: totalSlots - usedSlots };
}

const ARMOR_HEAD = 5;
const ARMOR_CHEST = 6;
const ARMOR_LEGS = 7;
const ARMOR_FEET = 8;
const OFFHAND = 45;

function getEquipment(b: mineflayer.Bot): Record<string, string> {
	const result: Record<string, string> = {};
	const head = b.inventory.slots[ARMOR_HEAD];
	const chest = b.inventory.slots[ARMOR_CHEST];
	const legs = b.inventory.slots[ARMOR_LEGS];
	const feet = b.inventory.slots[ARMOR_FEET];
	const offhand = b.inventory.slots[OFFHAND];
	if (head) result.head = head.displayName ?? head.name;
	if (chest) result.chest = chest.displayName ?? chest.name;
	if (legs) result.legs = legs.displayName ?? legs.name;
	if (feet) result.feet = feet.displayName ?? feet.name;
	if (offhand) result.offhand = offhand.displayName ?? offhand.name;
	const hand = b.heldItem;
	if (hand) result.hand = hand.displayName ?? hand.name;
	return result;
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
	name: "minecraft",
	version: "0.1.0",
});

server.tool("observe_state", "Minecraft ボットの現在の状態を取得する", {}, () => {
	if (!bot || !bot.entity) {
		return { content: [{ type: "text", text: "ボット未接続" }] };
	}

	const pos = bot.entity.position;
	const timeOfDay = bot.time?.timeOfDay;
	const state = {
		position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
		health: bot.health,
		food: bot.food,
		timePeriod: timeOfDay === undefined ? "不明" : getTimePeriod(timeOfDay),
		weather: getWeather(bot),
		nearbyEntities: getNearbyEntities(bot, 5),
		inventory: getInventorySummary(bot),
		equipment: getEquipment(bot),
		recentEvents: events.slice(-5),
	};

	return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
});

server.tool(
	"get_recent_events",
	"Minecraft ボットの直近イベントログを取得する",
	{
		limit: z
			.number()
			.min(1)
			.max(50)
			.default(10)
			.describe("取得するイベント数（デフォルト: 10、最大: 50）"),
	},
	({ limit }) => {
		const recent = events.slice(-limit);
		return { content: [{ type: "text", text: JSON.stringify(recent, null, 2) }] };
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
