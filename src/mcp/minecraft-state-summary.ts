import {
	formatActionState,
	formatEntityEntry,
	formatEquipmentText,
	formatHealthBar,
	formatInventoryText,
} from "./minecraft-helpers.ts";
import type { ActionState, Importance } from "./minecraft-helpers.ts";

export interface BotStateInput {
	position: { x: number; y: number; z: number };
	health: number;
	food: number;
	timePeriod: string;
	weather: string;
	action: ActionState;
	nearbyEntities: { name: string; distance: number; type: string }[];
	inventory: { items: { name: string; count: number }[]; emptySlots: number };
	equipment: Record<string, string>;
	recentEvents: { timestamp: string; kind: string; description: string; importance: Importance }[];
}

/** ボット状態を自然言語要約テキストに変換する */
export function summarizeState(state: BotStateInput): string {
	const lines: string[] = [];

	// 状態セクション
	const { x, y, z } = state.position;
	lines.push("## 状態");
	lines.push(
		`場所: (${String(x)}, ${String(y)}, ${String(z)}) | 体力: ${formatHealthBar(state.health)} | 空腹: 🍖 ${String(Math.round(state.food))}/20`,
	);
	lines.push(`時間帯: ${state.timePeriod} | 天気: ${state.weather}`);
	lines.push(`行動: ${formatActionState(state.action)}`);

	// 周辺セクション
	if (state.nearbyEntities.length > 0) {
		lines.push("");
		lines.push("## 周辺");
		for (const entity of state.nearbyEntities) {
			lines.push(formatEntityEntry(entity));
		}
	}

	// インベントリセクション
	lines.push("");
	lines.push(`## インベントリ (${String(state.inventory.emptySlots)} 空き)`);
	lines.push(formatInventoryText(state.inventory.items, state.inventory.emptySlots));

	// 装備セクション
	lines.push("");
	lines.push("## 装備");
	lines.push(formatEquipmentText(state.equipment));

	// 直近イベントセクション（medium 以上のみ）
	const importantEvents = state.recentEvents.filter(
		(e) => e.importance === "medium" || e.importance === "high",
	);
	if (importantEvents.length > 0) {
		lines.push("");
		lines.push("## 直近イベント");
		for (const event of importantEvents) {
			// HH:MM 部分を抽出
			const time = event.timestamp.slice(11, 16);
			lines.push(`[${time}] ${event.description}`);
		}
	}

	return lines.join("\n");
}

export interface BotEventInput {
	timestamp: string;
	kind: string;
	description: string;
	importance: Importance;
}

/** イベントリストをテキスト形式に変換する */
export function formatEvents(events: BotEventInput[]): string {
	if (events.length === 0) return "イベントなし";
	return events.map((e) => `[${e.timestamp}] ${e.kind}: ${e.description}`).join("\n");
}
