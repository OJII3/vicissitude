import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "../../store/db.ts";
import { consumeEvents } from "../../store/queries.ts";

export interface EventBufferDeps {
	db: StoreDb;
	guildId: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

function formatEvents(rows: { payload: string }[]): string {
	const events = rows.map((r) => JSON.parse(r.payload));
	return JSON.stringify(events, null, 2);
}

async function pollEvents(
	db: StoreDb,
	guildId: string,
	deadlineMs: number,
): Promise<string | null> {
	if (Date.now() >= deadlineMs) return null;
	await sleep(1000);
	const rows = consumeEvents(db, guildId);
	if (rows.length > 0) return formatEvents(rows);
	return pollEvents(db, guildId, deadlineMs);
}

export function registerEventBufferTools(server: McpServer, deps: EventBufferDeps): void {
	const { db, guildId } = deps;

	server.tool(
		"wait_for_events",
		"イベントが届くまで待機し、届いたら消費して返す。タイムアウト時は空配列を返す。",
		{ timeout_seconds: z.number().min(1).max(120).default(60) },
		async ({ timeout_seconds }) => {
			const immediate = consumeEvents(db, guildId);
			if (immediate.length > 0) {
				return {
					content: [{ type: "text" as const, text: formatEvents(immediate) }],
				};
			}

			const deadline = Date.now() + timeout_seconds * 1000;
			const result = await pollEvents(db, guildId, deadline);
			return { content: [{ type: "text" as const, text: result ?? "[]" }] };
		},
	);
}
