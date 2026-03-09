import mineflayer from "mineflayer";
import pathfinder from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { mineflayer as prismarineViewer } from "prismarine-viewer";

import type { BotContext } from "./bot-context.ts";
import { getTimePeriod, getWeather } from "./bot-queries.ts";
import type { Importance } from "./helpers.ts";

export interface BotConfig {
	host: string;
	port: number;
	username: string;
	version: string | undefined;
	viewerPort: number;
}

interface TrackingState {
	lastHealth: number;
	lastFood: number;
	lastTimePeriod: string;
	lastWeather: string;
}

interface ReconnectState {
	delay: number;
	shuttingDown: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

const MAX_RECONNECT_DELAY = 60_000;

function cleanupBot(b: mineflayer.Bot): void {
	// prismarine-viewer adds `viewer` dynamically; not in mineflayer's type definitions
	const viewer = (b as unknown as Record<string, unknown>).viewer as
		| { close?: () => void }
		| undefined;
	if (viewer?.close) {
		try {
			viewer.close();
		} catch {}
	}
	b.removeAllListeners();
	if (typeof b.quit === "function") b.quit();
}

function startViewer(b: mineflayer.Bot, viewerPort: number): void {
	prismarineViewer(b, { viewDistance: 4, firstPerson: true, port: viewerPort });
	console.error(`[minecraft] Viewer running on *:${String(viewerPort)}`);
}

function registerCoreEvents(
	b: mineflayer.Bot,
	ctx: BotContext,
	tracking: TrackingState,
	viewerPort: number,
	onSpawnReady: () => void,
	onDisconnect: () => void,
): void {
	b.once("spawn", () => {
		console.error(`[minecraft] Bot spawned as ${b.username} at ${b.entity.position}`);
		ctx.pushEvent("spawn", `Spawned at ${b.entity.position}`, "high");
		onSpawnReady();
		startViewer(b, viewerPort);
	});
	b.on("death", () => ctx.pushEvent("death", "Bot died", "high"));
	b.on("health", () => {
		const h = Math.round(b.health);
		const f = Math.round(b.food);
		const healthDelta = Math.abs(h - tracking.lastHealth);
		const droppedToLow = h <= 5 && tracking.lastHealth > 5;
		if (tracking.lastHealth < 0 || healthDelta >= 5 || droppedToLow) {
			const importance: Importance = h <= 5 ? "medium" : "low";
			tracking.lastHealth = h;
			tracking.lastFood = f;
			ctx.pushEvent("health", `Health: ${String(h)}, Food: ${String(f)}`, importance);
		} else if (f !== tracking.lastFood) {
			tracking.lastHealth = h;
			tracking.lastFood = f;
		}
	});
	b.on("chat", (username: string, message: string) => {
		if (username !== b.username) ctx.pushEvent("chat", `<${username}> ${message}`, "medium");
	});
	b.on("kicked", (reason: string) => {
		console.error(`[minecraft] Kicked: ${reason}`);
		ctx.pushEvent("kicked", `Kicked: ${reason}`, "high");
	});
	b.on("entityHurt", (entity: Entity) => {
		if (entity === b.entity) ctx.pushEvent("damage", "Bot took damage", "medium");
	});
	b.on("end", (reason: string) => {
		console.error(`[minecraft] Disconnected: ${reason}`);
		ctx.pushEvent("disconnect", `Disconnected: ${reason}`, "high");
		onDisconnect();
	});
	b.on("error", (err: Error) => console.error(`[minecraft] Error: ${err.message}`));
}

function registerWorldEvents(b: mineflayer.Bot, ctx: BotContext, tracking: TrackingState): void {
	b.on("playerJoined", (player: { username: string }) => {
		ctx.pushEvent("playerJoined", `${player.username} が参加`, "medium");
	});
	b.on("playerLeft", (player: { username: string }) => {
		ctx.pushEvent("playerLeft", `${player.username} が退出`, "medium");
	});
	b.on("time", () => {
		const timeOfDay = b.time?.timeOfDay;
		if (timeOfDay === undefined) return;
		const period = getTimePeriod(timeOfDay);
		if (period !== tracking.lastTimePeriod && tracking.lastTimePeriod !== "") {
			ctx.pushEvent("timeChange", `${period}になった`, "low");
		}
		tracking.lastTimePeriod = period;
	});
	b.on("rain", () => {
		const weather = getWeather(b);
		if (weather !== tracking.lastWeather && tracking.lastWeather !== "") {
			ctx.pushEvent("weatherChange", `天気が${weather}に変わった`, "low");
		}
		tracking.lastWeather = weather;
	});
}

function initBot(
	config: BotConfig,
	ctx: BotContext,
	tracking: TrackingState,
	reconnect: ReconnectState,
	botFactory: () => mineflayer.Bot,
): mineflayer.Bot {
	const b = mineflayer.createBot({
		host: config.host,
		port: config.port,
		username: config.username,
		version: config.version,
		auth: "offline",
	});
	b.loadPlugin(pathfinder.pathfinder);
	registerCoreEvents(
		b,
		ctx,
		tracking,
		config.viewerPort,
		() => {
			reconnect.delay = 1000;
		},
		() => {
			if (!reconnect.shuttingDown) scheduleReconnect(reconnect, ctx, botFactory);
		},
	);
	registerWorldEvents(b, ctx, tracking);
	return b;
}

function scheduleReconnect(
	state: ReconnectState,
	ctx: BotContext,
	botFactory: () => mineflayer.Bot,
): void {
	if (state.timer) clearTimeout(state.timer);
	console.error(`[minecraft] Reconnecting in ${String(state.delay)}ms...`);
	state.timer = setTimeout(() => {
		state.timer = null;
		if (state.shuttingDown) return;
		const currentBot = ctx.getBot();
		if (currentBot) cleanupBot(currentBot);
		ctx.setBot(botFactory());
	}, state.delay);
	state.delay = Math.min(state.delay * 2, MAX_RECONNECT_DELAY);
}

export function createBotConnection(
	config: BotConfig,
	ctx: BotContext,
): { start(): void; shutdown(): void } {
	const reconnect: ReconnectState = { delay: 1000, shuttingDown: false, timer: null };
	const tracking: TrackingState = {
		lastHealth: -1,
		lastFood: -1,
		lastTimePeriod: "",
		lastWeather: "",
	};
	const botFactory = (): mineflayer.Bot => initBot(config, ctx, tracking, reconnect, botFactory);

	return {
		start() {
			ctx.setBot(botFactory());
		},
		shutdown() {
			reconnect.shuttingDown = true;
			if (reconnect.timer) {
				clearTimeout(reconnect.timer);
				reconnect.timer = null;
			}
			const currentBot = ctx.getBot();
			if (currentBot) {
				cleanupBot(currentBot);
				ctx.setBot(null);
			}
		},
	};
}
