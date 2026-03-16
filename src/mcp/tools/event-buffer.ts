import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "@vicissitude/store/db";
import { consumeEvents, hasEvents } from "@vicissitude/store/queries";

export interface EventBufferDeps {
	db: StoreDb;
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
	const { db } = deps;

	server.tool(
		"wait_for_events",
		"イベントが届くまで待機し、届いたら最大10件まとめて消費して返す。タイムアウト時は空配列を返す。",
		{
			agent_id: z
				.string()
				.min(1)
				.describe("対象のエージェント ID (例: discord:123456, minecraft:brain)"),
			timeout_seconds: z.number().min(1).max(172800).default(60),
		},
		async ({ agent_id, timeout_seconds }) => {
			const immediate = consumeEvents(db, agent_id, MAX_BATCH_SIZE);
			if (immediate.length > 0) {
				return {
					content: [{ type: "text" as const, text: formatEvents(immediate) }],
				};
			}

			const deadline = Date.now() + timeout_seconds * 1000;
			const result = await pollEvents(db, agent_id, deadline);
			return { content: [{ type: "text" as const, text: result ?? "[]" }] };
		},
	);
}
