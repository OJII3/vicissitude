import type { Logger } from "@vicissitude/shared/types";
import mineflayer from "mineflayer";
import pathfinder from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { mineflayer as prismarineViewer } from "prismarine-viewer";

import type { BotContext } from "./bot-context.ts";
import { getTimePeriod, getWeather } from "./bot-queries.ts";
import type { McAuthMode } from "./constants.ts";
import type { Importance } from "./helpers.ts";

export interface BotConfig {
	host: string;
	port: number;
	username: string;
	version: string | undefined;
	authMode: McAuthMode;
	profilesFolder: string | undefined;
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

const AUTH_ERROR_PATTERNS = [
	// node-minecraft-protocol / mineflayer
	"invalid credentials",
	"does not own",
	"not authenticated",
	// prismarine-auth: device code timeout
	"authentication failed, timed out",
	// prismarine-auth: token refresh failure
	"cannot refresh without refresh token",
	// prismarine-auth: XSTS / device code acquisition failure
	"failed to obtain a xsts token",
	"failed to request",
	"failed to acquire",
	// prismarine-auth: Xbox Live account restrictions
	"xbox",
] as const;

function isAuthError(err: Error): boolean {
	const msg = err.message.toLowerCase();
	return AUTH_ERROR_PATTERNS.some((p) => msg.includes(p));
}

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

function startViewer(b: mineflayer.Bot, viewerPort: number, logger: Logger): void {
	prismarineViewer(b, { viewDistance: 4, firstPerson: true, port: viewerPort });
	logger.info(`[minecraft] Viewer running on *:${String(viewerPort)}`);
}

function handleHealthChange(b: mineflayer.Bot, ctx: BotContext, tracking: TrackingState): void {
	const h = Math.round(b.health);
	const f = Math.round(b.food);
	const healthDelta = Math.abs(h - tracking.lastHealth);
	const droppedToLow = h <= 5 && tracking.lastHealth > 5;
	const droppedToStarving = f === 0 && tracking.lastFood > 0;
	if (tracking.lastHealth < 0 || healthDelta >= 5 || droppedToLow || droppedToStarving) {
		const importance: Importance = h <= 5 || droppedToStarving ? "medium" : "low";
		tracking.lastHealth = h;
		tracking.lastFood = f;
		ctx.pushEvent("health", `Health: ${String(h)}, Food: ${String(f)}`, importance);
	} else if (f !== tracking.lastFood) {
		tracking.lastHealth = h;
		tracking.lastFood = f;
	}
}

interface CoreEventHandlers {
	onSpawnReady: () => void;
	onDisconnect: () => void;
	onAuthFailure: () => void;
}

interface CoreEventParams {
	b: mineflayer.Bot;
	ctx: BotContext;
	tracking: TrackingState;
	viewerPort: number;
	logger: Logger;
	handlers: CoreEventHandlers;
}

function registerCoreEvents(params: CoreEventParams): void {
	const { b, ctx, tracking, viewerPort, logger, handlers } = params;
	const { onSpawnReady, onDisconnect, onAuthFailure } = handlers;
	b.once("spawn", () => {
		logger.info(`[minecraft] Bot spawned as ${b.username} at ${String(b.entity.position)}`);
		ctx.pushEvent("spawn", `Spawned at ${String(b.entity.position)}`, "high");
		onSpawnReady();
		startViewer(b, viewerPort, logger);
	});
	let lastRespawnTime = 0;
	const RESPAWN_COOLDOWN_MS = 1000;
	b.on("death", () => {
		ctx.pushEvent("death", "Bot died", "high");
		const now = Date.now();
		if (now - lastRespawnTime >= RESPAWN_COOLDOWN_MS) {
			try {
				b.respawn();
				lastRespawnTime = now;
				logger.info("[minecraft] Auto-respawned after death");
			} catch (err) {
				logger.error("[minecraft] respawn() failed:", err);
			}
		} else {
			logger.warn("[minecraft] Respawn skipped (cooldown)");
		}
	});
	b.on("health", () => handleHealthChange(b, ctx, tracking));
	b.on("chat", (username: string, message: string) => {
		if (username !== b.username) ctx.pushEvent("chat", `<${username}> ${message}`, "medium");
	});
	b.on("kicked", (reason: string | Record<string, unknown>) => {
		const text = typeof reason === "string" ? reason : JSON.stringify(reason);
		logger.warn(`[minecraft] Kicked: ${text}`);
		ctx.pushEvent("kicked", `Kicked: ${text}`, "high");
	});
	b.on("entityHurt", (entity: Entity) => {
		if (entity === b.entity) ctx.pushEvent("damage", "Bot took damage", "medium");
	});
	b.on("end", (reason: string) => {
		logger.info(`[minecraft] Disconnected: ${reason}`);
		ctx.pushEvent("disconnect", `Disconnected: ${reason}`, "high");
		onDisconnect();
	});
	b.on("error", (err: Error) => {
		logger.error(`[minecraft] Error: ${err.message}`);
		if (isAuthError(err)) {
			logger.error("[minecraft] Authentication failed — disabling reconnect");
			onAuthFailure();
		}
	});
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

// oxlint-disable-next-line max-params -- internal wiring function, params are all distinct concerns
function initBot(
	config: BotConfig,
	ctx: BotContext,
	tracking: TrackingState,
	reconnect: ReconnectState,
	logger: Logger,
	botFactory: () => mineflayer.Bot,
): mineflayer.Bot {
	const botOptions: Parameters<typeof mineflayer.createBot>[0] = {
		host: config.host,
		port: config.port,
		username: config.username,
		version: config.version,
		auth: config.authMode,
	};
	if (config.authMode === "microsoft" && config.profilesFolder) {
		botOptions.profilesFolder = config.profilesFolder;
	}
	const b = mineflayer.createBot(botOptions);
	b.loadPlugin(pathfinder.pathfinder);
	registerCoreEvents({
		b,
		ctx,
		tracking,
		viewerPort: config.viewerPort,
		logger,
		handlers: {
			onSpawnReady: () => {
				reconnect.delay = 1000;
			},
			onDisconnect: () => {
				if (!reconnect.shuttingDown) scheduleReconnect(reconnect, ctx, logger, botFactory);
			},
			onAuthFailure: () => {
				reconnect.shuttingDown = true;
			},
		},
	});
	registerWorldEvents(b, ctx, tracking);
	return b;
}

function scheduleReconnect(
	state: ReconnectState,
	ctx: BotContext,
	logger: Logger,
	botFactory: () => mineflayer.Bot,
): void {
	if (state.timer) clearTimeout(state.timer);
	logger.info(`[minecraft] Reconnecting in ${String(state.delay)}ms...`);
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
	logger: Logger,
): { start(): void; shutdown(): void; triggerReconnect(): void } {
	const reconnect: ReconnectState = { delay: 1000, shuttingDown: false, timer: null };
	const tracking: TrackingState = {
		lastHealth: -1,
		lastFood: -1,
		lastTimePeriod: "",
		lastWeather: "",
	};
	const botFactory = (): mineflayer.Bot =>
		initBot(config, ctx, tracking, reconnect, logger, botFactory);

	return {
		start() {
			reconnect.shuttingDown = false;
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
		triggerReconnect() {
			if (reconnect.shuttingDown) return;
			reconnect.delay = 0;
			scheduleReconnect(reconnect, ctx, logger, botFactory);
			// scheduleReconnect 内の *2 で 0 のままになるのを防ぎ、次回以降の指数バックオフを維持する
			reconnect.delay = 1000;
		},
	};
}
