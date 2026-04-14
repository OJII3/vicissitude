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
	getEvents(): BotEvent[];
	pushEvent(kind: string, description: string, importance: Importance): void;
	getActionState(): ActionState;
	setActionState(state: ActionState): void;
}

const BOT_EVENT_KINDS = new Set(["spawn", "death", "kicked", "disconnect"]);

export interface CreateBotContextOptions {
	metrics?: MetricsCollector;
	urgentEventNotifier?: (kind: string, description: string, importance: Importance) => void;
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
		getEvents: () => events,
		pushEvent: (kind, description, importance) => {
			events.push({ timestamp: new Date().toISOString(), kind, description, importance });
			if (events.length > MAX_EVENTS) events.shift();
			if (metrics && BOT_EVENT_KINDS.has(kind)) {
				metrics.incrementCounter(METRIC.MC_BOT_EVENTS, { kind });
			}
			urgentEventNotifier?.(kind, description, importance);
		},
		getActionState: () => actionState,
		setActionState: (state) => {
			actionState.type = state.type;
			actionState.target = state.target;
			actionState.jobId = state.jobId;
			actionState.progress = state.progress;
		},
	};
}
