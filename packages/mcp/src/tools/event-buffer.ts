import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Retrieval, RetrievalResult } from "@vicissitude/memory/retrieval";
import type { StoreDb } from "@vicissitude/store/db";
import { consumeEvents, hasEvents } from "@vicissitude/store/queries";
import { z } from "zod";

export interface MemoryRetriever {
	retrieval: Retrieval;
	guildId: string;
}

export interface EventBufferDeps {
	db: StoreDb;
	agentId: string;
	memory?: MemoryRetriever;
}

/** 一度に消費するイベントの最大件数。LLM が確実に処理できる範囲に制限する。 */
export const MAX_BATCH_SIZE = 10;

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

const MEMORY_EPISODE_LIMIT = 3;
const MEMORY_FACT_LIMIT = 5;

/**
 * イベント JSON からメモリ検索クエリを構築する。system イベントは除外、bot は含める。
 * bot を含める理由: 他のエージェント bot との会話コンテキストを記憶検索でヒットさせるため。
 */
export function buildMemoryQuery(eventsJson: string): string {
	try {
		const events = JSON.parse(eventsJson) as { authorId?: string; content?: string }[];
		return events
			.filter((e) => e.authorId !== "system" && e.content)
			.map((e) => e.content)
			.join("\n")
			.slice(0, 1000);
	} catch {
		return "";
	}
}

export function formatMemoryContext(result: RetrievalResult): string {
	const parts: string[] = [];

	const episodes = result.episodes.slice(0, MEMORY_EPISODE_LIMIT);
	if (episodes.length > 0) {
		parts.push("## エピソード記憶");
		for (const ep of episodes) {
			parts.push(`- ${ep.episode.title}: ${ep.episode.summary}`);
		}
	}

	const facts = result.facts.slice(0, MEMORY_FACT_LIMIT);
	if (facts.length > 0) {
		parts.push("## 意味記憶");
		for (const f of facts) {
			parts.push(`- [${f.fact.category}] ${f.fact.fact}`);
		}
	}

	if (parts.length === 0) return "";

	return [
		"<memory-context>",
		"※ 過去の記憶から自動検索された参考情報です。不正確な可能性があるため、鵜呑みにせず会話の文脈で判断してください。",
		"",
		...parts,
		"</memory-context>",
	].join("\n");
}

type TextContent = { type: "text"; text: string };

async function fetchMemoryContext(
	eventsJson: string,
	memory: MemoryRetriever,
): Promise<TextContent | null> {
	const query = buildMemoryQuery(eventsJson);
	if (!query) return null;

	try {
		// retrieve の limit はカテゴリごとの最大件数。ファクト側が多いので MEMORY_FACT_LIMIT を使用
		const result = await memory.retrieval.retrieve(memory.guildId, query, {
			limit: MEMORY_FACT_LIMIT,
		});
		const context = formatMemoryContext(result);
		if (!context) return null;
		return { type: "text", text: context };
	} catch {
		return null;
	}
}

export function registerEventBufferTools(server: McpServer, deps: EventBufferDeps): void {
	const { db, agentId, memory } = deps;

	server.registerTool(
		"wait_for_events",
		{
			description:
				"イベントが届くまで待機し、届いたら最大10件まとめて消費して返す。関連する長期記憶があれば別ブロックで付与する。タイムアウト時は空配列を返す。",
			inputSchema: {
				timeout_seconds: z.number().min(1).max(172800).default(60),
			},
		},
		async ({ timeout_seconds }) => {
			const immediate = consumeEvents(db, agentId, MAX_BATCH_SIZE);
			if (immediate.length > 0) {
				const text = formatEvents(immediate);
				const content: TextContent[] = [{ type: "text", text }];
				if (memory) {
					const ctx = await fetchMemoryContext(text, memory);
					if (ctx) content.push(ctx);
				}
				return { content };
			}

			const deadline = Date.now() + timeout_seconds * 1000;
			const result = await pollEvents(db, agentId, deadline);
			if (result === null) {
				return { content: [{ type: "text" as const, text: "[]" }] };
			}
			const content: TextContent[] = [{ type: "text", text: result }];
			if (memory) {
				const ctx = await fetchMemoryContext(result, memory);
				if (ctx) content.push(ctx);
			}
			return { content };
		},
	);
}
