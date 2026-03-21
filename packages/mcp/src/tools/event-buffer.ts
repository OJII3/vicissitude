import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreDb } from "@vicissitude/store/db";
import { consumeEvents, hasEvents } from "@vicissitude/store/queries";
import { z } from "zod";

export interface EventBufferDeps {
	db: StoreDb;
	agentId: string;
}

/** 一度に消費するイベントの最大件数。LLM が確実に処理できる範囲に制限する。 */
const MAX_BATCH_SIZE = 10;

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
	agentId: string,
	deadlineMs: number,
	pollIntervalMs = 1000,
): Promise<string | null> {
	while (Date.now() < deadlineMs) {
		if (hasEvents(db, agentId)) {
			const rows = consumeEvents(db, agentId, MAX_BATCH_SIZE);
			if (rows.length > 0) return formatEvents(rows);
		}
		// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
		await sleep(pollIntervalMs);
	}
	return null;
}

export function registerEventBufferTools(server: McpServer, deps: EventBufferDeps): void {
	const { db, agentId } = deps;

	server.registerTool(
		"wait_for_events",
		{
			description:
				"イベントが届くまで待機し、届いたら最大10件まとめて消費して返す。タイムアウト時は空配列を返す。",
			inputSchema: {
				timeout_seconds: z.number().min(1).max(172800).default(60),
			},
		},
		async ({ timeout_seconds }) => {
			const immediate = consumeEvents(db, agentId, MAX_BATCH_SIZE);
			if (immediate.length > 0) {
				return {
					content: [{ type: "text" as const, text: formatEvents(immediate) }],
				};
			}

			const deadline = Date.now() + timeout_seconds * 1000;
			const result = await pollEvents(db, agentId, deadline);
			return { content: [{ type: "text" as const, text: result ?? "[]" }] };
		},
	);
}
