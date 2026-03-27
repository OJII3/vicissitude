import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Retrieval, RetrievalResult } from "@vicissitude/memory/retrieval";
import type { Attachment } from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { consumeEvents, hasEvents } from "@vicissitude/store/queries";
import { z } from "zod";

export interface MemoryRetriever {
	retrieval: Retrieval;
	guildId: string;
}

/** イベント返却時に対象チャンネルへ typing インジケーターを自動送信するためのポート */
export type TypingSender = (channelId: string) => Promise<void>;

export interface EventBufferDeps {
	db: StoreDb;
	agentId: string;
	memory?: MemoryRetriever;
	typingSender?: TypingSender;
}

/** 一度に消費するイベントの最大件数。LLM が確実に処理できる範囲に制限する。 */
export const MAX_BATCH_SIZE = 10;

// ─── ParsedEvent ─────────────────────────────────────────────────

export interface ParsedEvent {
	ts: string;
	content: string;
	authorId: string;
	authorName: string;
	messageId: string;
	attachments?: Attachment[];
	metadata?: {
		channelId?: string;
		channelName?: string;
		guildId?: string;
		isBot?: boolean;
		isMentioned?: boolean;
		isThread?: boolean;
	};
}

// ─── parseEvents ─────────────────────────────────────────────────

/** payload 文字列の配列をパースして ParsedEvent 配列を返す。不正 JSON は _raw/_error 付きで返す */
export function parseEvents(rows: { payload: string }[]): ParsedEvent[] {
	return rows.map((r) => {
		try {
			return JSON.parse(r.payload) as ParsedEvent;
		} catch {
			return { _raw: r.payload, _error: "invalid JSON" } as never;
		}
	});
}

// ─── formatEvents ────────────────────────────────────────────────

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstString(isoTs: string): string {
	const utc = new Date(isoTs).getTime();
	const jst = new Date(utc + JST_OFFSET_MS);
	const y = jst.getUTCFullYear();
	const mo = String(jst.getUTCMonth() + 1).padStart(2, "0");
	const d = String(jst.getUTCDate()).padStart(2, "0");
	const h = String(jst.getUTCHours()).padStart(2, "0");
	const mi = String(jst.getUTCMinutes()).padStart(2, "0");
	return `${y}-${mo}-${d} ${h}:${mi}`;
}

/** ParsedEvent 配列を人間可読形式にフォーマットする */
export function formatEvents(events: ParsedEvent[]): string {
	if (events.length === 0) return "";

	return events
		.map((e) => {
			// エラーイベント
			if ("_error" in e && "_raw" in e) {
				const raw = (e as unknown as { _raw: string })._raw;
				const err = (e as unknown as { _error: string })._error;
				return `[ERROR] ${err}: ${raw}`;
			}

			const dateStr = toJstString(e.ts);
			const channel = e.metadata?.channelName ? ` #${e.metadata.channelName}` : "";
			const flags: string[] = [];
			if (e.metadata?.isMentioned) flags.push("(mentioned)");
			if (e.metadata?.isBot) flags.push("(bot)");
			if (e.attachments && e.attachments.length > 0) {
				flags.push(`[添付: ${e.attachments.length}件]`);
			}
			const flagStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";

			const isUserMessage = e.authorId !== "system" && e.metadata?.isBot !== true;
			const content = isUserMessage ? `<user_message>${e.content}</user_message>` : e.content;

			return `[${dateStr}${channel}] ${e.authorName}: ${content}${flagStr}`;
		})
		.join("\n");
}

// ─── formatEventMetadata ─────────────────────────────────────────

/** 技術的メタデータを <event-metadata> ブロックとして返す */
export function formatEventMetadata(events: ParsedEvent[]): string {
	if (events.length === 0) return "";

	const metadata = events.map((e) => ({
		channelId: e.metadata?.channelId,
		messageId: e.messageId,
		guildId: e.metadata?.guildId,
		authorId: e.authorId,
	}));

	return `<event-metadata>\n${JSON.stringify(metadata)}\n</event-metadata>`;
}

// ─── buildMemoryQuery ────────────────────────────────────────────

/**
 * ParsedEvent 配列からメモリ検索クエリを構築する。system イベントは除外、bot は含める。
 * bot を含める理由: 他のエージェント bot との会話コンテキストを記憶検索でヒットさせるため。
 */
export function buildMemoryQuery(events: ParsedEvent[]): string {
	return events
		.filter((e) => e.authorId !== "system" && e.content)
		.map((e) => e.content)
		.join("\n")
		.slice(0, 1000);
}

// ─── formatMemoryContext ─────────────────────────────────────────

const MEMORY_EPISODE_LIMIT = 3;
const MEMORY_FACT_LIMIT = 5;

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

// ─── extractTypingChannels ───────────────────────────────────────

/** ParsedEvent 配列から返信対象（system/bot 以外）のユニークな channelId を抽出する */
export function extractTypingChannels(events: ParsedEvent[]): string[] {
	const channels = new Set<string>();
	for (const e of events) {
		if (e.authorId === "system") continue;
		if (e.metadata?.isBot) continue;
		if (e.metadata?.channelId) channels.add(e.metadata.channelId);
	}
	return [...channels];
}

// ─── pollEvents ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function pollEvents(
	db: StoreDb,
	agentId: string,
	deadlineMs: number,
	pollIntervalMs = 1000,
): Promise<ParsedEvent[] | null> {
	while (Date.now() < deadlineMs) {
		if (hasEvents(db, agentId)) {
			const rows = consumeEvents(db, agentId, MAX_BATCH_SIZE);
			if (rows.length > 0) return parseEvents(rows);
		}
		// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
		await sleep(pollIntervalMs);
	}
	return null;
}

// ─── fetchMemoryContext ──────────────────────────────────────────

type TextContent = { type: "text"; text: string };

async function fetchMemoryContext(
	events: ParsedEvent[],
	memory: MemoryRetriever,
): Promise<TextContent | null> {
	const query = buildMemoryQuery(events);
	if (!query) return null;

	try {
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

// ─── registerEventBufferTools ────────────────────────────────────

export function registerEventBufferTools(server: McpServer, deps: EventBufferDeps): void {
	const { db, agentId, memory, typingSender } = deps;

	/** ParsedEvent 配列の対象チャンネルに typing インジケーターを送信する（fire-and-forget） */
	function sendTypingForEvents(events: ParsedEvent[]): void {
		if (!typingSender) return;
		const channels = extractTypingChannels(events);
		for (const channelId of channels) {
			typingSender(channelId).catch(() => {});
		}
	}

	server.registerTool(
		"wait_for_events",
		{
			description:
				"イベントが届くまで待機し、届いたら最大10件まとめて消費して返す。関連する長期記憶があれば別ブロックで付与する。対象チャンネルにはタイピングインジケーターを自動送信する。タイムアウト時は空配列を返す。",
			inputSchema: {
				timeout_seconds: z.number().min(1).max(172800).default(60),
			},
		},
		async ({ timeout_seconds }) => {
			const immediate = consumeEvents(db, agentId, MAX_BATCH_SIZE);
			if (immediate.length > 0) {
				const events = parseEvents(immediate);
				sendTypingForEvents(events);
				const text = formatEvents(events);
				const metadataText = formatEventMetadata(events);
				const content: TextContent[] = [
					{ type: "text", text: text + (metadataText ? `\n${metadataText}` : "") },
				];
				if (memory) {
					const ctx = await fetchMemoryContext(events, memory);
					if (ctx) content.push(ctx);
				}
				return { content };
			}

			const deadline = Date.now() + timeout_seconds * 1000;
			const result = await pollEvents(db, agentId, deadline);
			if (result === null) {
				return { content: [{ type: "text" as const, text: "イベントなし（タイムアウト）" }] };
			}
			sendTypingForEvents(result);
			const text = formatEvents(result);
			const metadataText = formatEventMetadata(result);
			const content: TextContent[] = [
				{ type: "text", text: text + (metadataText ? `\n${metadataText}` : "") },
			];
			if (memory) {
				const ctx = await fetchMemoryContext(result, memory);
				if (ctx) content.push(ctx);
			}
			return { content };
		},
	);
}
