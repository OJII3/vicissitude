import { METRIC } from "@vicissitude/observability/metrics";
import type { MetricsCollector } from "@vicissitude/shared/types";
import type mineflayer from "mineflayer";

import type { ActionState, Importance } from "./helpers.ts";

export interface BotEvent {
	timestamp: string;
	kind: string;
	description: string;
	importance: Importance;
}

const MAX_EVENTS = 100;

export interface BotContext {
	getBot(): mineflayer.Bot | null;
	setBot(bot: mineflayer.Bot | null): void;
	getEvents(): ReadonlyArray<Readonly<BotEvent>>;
	pushEvent(kind: string, description: string, importance: Importance): void;
	getActionState(): Readonly<ActionState>;
	setActionState(state: ActionState): void;
}

const BOT_EVENT_KINDS = new Set(["spawn", "death", "kicked", "disconnect"]);

export interface CreateBotContextOptions {
	metrics?: MetricsCollector;
	urgentEventNotifier?: (kind: string, description: string, importance: Importance) => void;
}

function copyEvent(event: BotEvent): BotEvent {
	return { ...event };
}

function copyActionState(state: ActionState): ActionState {
	return { ...state };
}

export function createBotContext(options?: CreateBotContextOptions): BotContext {
	let bot: mineflayer.Bot | null = null;
	const events: BotEvent[] = [];
	const actionState: ActionState = { type: "idle" };
	const metrics = options?.metrics;
	const urgentEventNotifier = options?.urgentEventNotifier;

	return {
		getBot: () => bot,
		setBot: (b) => {
			bot = b;
		},
		getEvents: () => events.map((event) => copyEvent(event)),
		pushEvent: (kind, description, importance) => {
			events.push({ timestamp: new Date().toISOString(), kind, description, importance });
			if (events.length > MAX_EVENTS) events.shift();
			if (metrics && BOT_EVENT_KINDS.has(kind)) {
				metrics.incrementCounter(METRIC.MC_BOT_EVENTS, { kind });
			}
			urgentEventNotifier?.(kind, description, importance);
		},
		getActionState: () => copyActionState(actionState),
		setActionState: (state) => {
			actionState.type = state.type;
			actionState.target = state.target;
			actionState.jobId = state.jobId;
			actionState.progress = state.progress;
		},
	};
}
