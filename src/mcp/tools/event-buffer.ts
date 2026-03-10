import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "../../store/db.ts";
import { consumeEvents, hasEvents } from "../../store/queries.ts";

export interface EventBufferDeps {
	db: StoreDb;
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function formatEvents(rows: { payload: string }[]): string {
	const events = rows.map((r) => {
		try {
			return JSON.parse(r.payload);
		} catch {
			return { _raw: r.payload, _error: "invalid JSON" };
		}
	});
	return JSON.stringify(events, null, 2);
}

export async function pollEvents(
	db: StoreDb,
	guildId: string,
	deadlineMs: number,
): Promise<string | null> {
	while (Date.now() < deadlineMs) {
		if (hasEvents(db, guildId)) {
			const rows = consumeEvents(db, guildId);
			if (rows.length > 0) return formatEvents(rows);
		}
		// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
		await sleep(1000);
	}
	return null;
}

export function registerEventBufferTools(server: McpServer, deps: EventBufferDeps): void {
	const { db } = deps;

	server.tool(
		"wait_for_events",
		"イベントが届くまで待機し、届いたら消費して返す。タイムアウト時は空配列を返す。",
		{
			guild_id: z.string().min(1).describe("対象の guild ID"),
			timeout_seconds: z.number().min(1).max(172800).default(60),
		},
		async ({ guild_id, timeout_seconds }) => {
			const immediate = consumeEvents(db, guild_id);
			if (immediate.length > 0) {
				return {
					content: [{ type: "text" as const, text: formatEvents(immediate) }],
				};
			}

			const deadline = Date.now() + timeout_seconds * 1000;
			const result = await pollEvents(db, guild_id, deadline);
			return { content: [{ type: "text" as const, text: result ?? "[]" }] };
		},
	);
}
