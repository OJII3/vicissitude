import type { BridgeEvent } from "../../store/mc-bridge.ts";

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
