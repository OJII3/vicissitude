import { type BridgeEvent, parseBridgeEvent } from "../../store/mc-bridge.ts";

export const MAX_BRIDGE_MESSAGE_CHARS = 10_000;

export function formatBridgeEvents(events: BridgeEvent[]): string {
	const formatted = events.map((e) => ({
		id: e.id,
		type: e.type,
		payload: e.payload,
		createdAt: new Date(e.createdAt).toISOString(),
	}));
	return JSON.stringify(formatted, null, 2);
}

/** minecraft_status 用: レポートをカテゴリ別にグループ化して人間可読な形式で返す */
export function formatStatusEvents(events: BridgeEvent[]): string {
	const reports = events.map((e) => parseBridgeEvent(e));

	const danger = reports.filter((r) => r.category === "danger");
	const stuck = reports.filter((r) => r.category === "stuck");
	const rest = reports.filter((r) => r.category !== "danger" && r.category !== "stuck");

	const lines: string[] = [];
	if (danger.length > 0) {
		lines.push("⚠ 危険/緊急:");
		for (const r of danger) lines.push(`  [${r.importance}] ${r.message} (${r.createdAt})`);
	}
	if (stuck.length > 0) {
		lines.push("🔄 行き詰まり:");
		for (const r of stuck) lines.push(`  ${r.message} (${r.createdAt})`);
	}
	if (rest.length > 0) {
		lines.push("直近の出来事:");
		for (const r of rest) {
			const tag = r.category === "status" ? "" : `[${r.category}] `;
			lines.push(`  ${tag}${r.message} (${r.createdAt})`);
		}
	}
	return lines.join("\n");
}
