import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeEmotion, isNeutralEmotion } from "@vicissitude/shared/emotion";
import type { MoodReader } from "@vicissitude/shared/ports";
import type { Attachment } from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { consumeEvents, hasEvents } from "@vicissitude/store/queries";
import { z } from "zod";

export interface RecentMessage {
	authorName: string;
	content: string;
	timestamp: Date;
	reactions: { emoji: string; count: number }[];
}

/** チャンネルIDを受け取り直近メッセージ一覧を返すポート */
export type RecentMessagesFetcher = (channelId: string) => Promise<RecentMessage[]>;

/** イベント返却時に対象チャンネルへ typing インジケーターを自動送信するためのポート */
export type TypingSender = (channelId: string) => Promise<void>;

export interface EventBufferDeps {
	db: StoreDb;
	agentId: string;
	recentMessagesFetcher?: RecentMessagesFetcher;
	moodReader?: MoodReader;
	typingSender?: TypingSender;
}

/** 一度に消費するイベントの最大件数。LLM が確実に処理できる範囲に制限する。 */
export const MAX_BATCH_SIZE = 10;

// ─── ActionHint ──────────────────────────────────────────────────

export type ActionHint = "respond" | "optional" | "read_only" | "internal";

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

// ─── classifyActionHint ──────────────────────────────────────────

export function classifyActionHint(event: ParsedEvent): ActionHint {
	if (event.authorId === "system") return "internal";
	if (event.metadata?.isBot) return "read_only";
	if (event.metadata?.isMentioned) return "respond";
	return "optional";
}

// ─── escapeUserMessageTag ────────────────────────────────────────

/** ユーザーメッセージ内の <user_message> / </user_message> タグをエスケープし、タグインジェクションを防ぐ */
export function escapeUserMessageTag(content: string): string {
	return content
		.replaceAll("</user_message>", "&lt;/user_message&gt;")
		.replaceAll("<user_message>", "&lt;user_message&gt;");
}

// ─── formatEvents ────────────────────────────────────────────────

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function toJstString(ts: string | Date): string {
	const utc = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
	const jst = new Date(utc + JST_OFFSET_MS);
	const y = jst.getUTCFullYear();
	const mo = String(jst.getUTCMonth() + 1).padStart(2, "0");
	const d = String(jst.getUTCDate()).padStart(2, "0");
	const h = String(jst.getUTCHours()).padStart(2, "0");
	const mi = String(jst.getUTCMinutes()).padStart(2, "0");
	return `${y}-${mo}-${d} ${h}:${mi}`;
}

/** parseEvents がパースに失敗したエラーイベントかどうかを判定する type guard */
export function isErrorEvent(e: ParsedEvent): e is ParsedEvent & { _raw: string; _error: string } {
	return "_error" in e && "_raw" in e;
}

/** ParsedEvent 配列を人間可読形式にフォーマットする */
export function formatEvents(events: ParsedEvent[]): string {
	if (events.length === 0) return "";

	return events
		.map((e) => {
			// エラーイベント
			if (isErrorEvent(e)) {
				return `[ERROR] ${e._error}: ${e._raw}`;
			}

			const dateStr = toJstString(e.ts);
			const channel = e.metadata?.channelName ? ` #${e.metadata.channelName}` : "";
			const hint = classifyActionHint(e);
			const extras: string[] = [];
			if (e.attachments && e.attachments.length > 0) {
				extras.push(`[添付: ${e.attachments.length}件]`);
			}
			extras.push(`[action: ${hint}]`);
			const extraStr = ` ${extras.join(" ")}`;

			const isUserMessage = e.authorId !== "system" && e.metadata?.isBot !== true;
			const content = isUserMessage
				? `<user_message>${escapeUserMessageTag(e.content)}</user_message>`
				: e.content;

			return `[${dateStr}${channel}] ${e.authorName}: ${content}${extraStr}`;
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

// ─── formatRecentMessages ────────────────────────────────────────

/**
 * チャンネル名 → メッセージ一覧の Map を受け取り、<recent-messages> ブロックとしてフォーマットする。
 * 空 Map の場合は空文字列を返す。
 */
export function formatRecentMessages(channelMessages: Map<string, RecentMessage[]>): string {
	if (channelMessages.size === 0) return "";

	const sections: string[] = [];
	for (const [channelName, messages] of channelMessages) {
		if (messages.length === 0) continue;
		const lines: string[] = [`## #${channelName}`];
		for (const msg of messages) {
			const dateStr = toJstString(msg.timestamp);
			let line = `[${dateStr} JST] ${msg.authorName}: ${msg.content}`;
			if (msg.reactions.length > 0) {
				const reactionStr = msg.reactions.map((r) => `${r.emoji}×${r.count}`).join(" ");
				line += ` [${reactionStr}]`;
			}
			lines.push(line);
		}
		sections.push(lines.join("\n"));
	}

	if (sections.length === 0) return "";

	return ["<recent-messages>", ...sections, "</recent-messages>"].join("\n\n");
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

// ─── fetchRecentMessagesContext ──────────────────────────────────

type TextContent = { type: "text"; text: string };

/** ParsedEvent 配列からユニークな channelId + channelName ペアを抽出する（全イベント対象） */
function extractAllChannels(events: ParsedEvent[]): { channelId: string; channelName: string }[] {
	const seen = new Map<string, string>();
	for (const e of events) {
		const { channelId, channelName } = e.metadata ?? {};
		if (channelId && channelName && !seen.has(channelId)) {
			seen.set(channelId, channelName);
		}
	}
	return [...seen.entries()].map(([channelId, channelName]) => ({ channelId, channelName }));
}

async function fetchRecentMessagesContext(
	events: ParsedEvent[],
	recentMessagesFetcher: RecentMessagesFetcher,
): Promise<TextContent | null> {
	const channels = extractAllChannels(events);
	if (channels.length === 0) return null;

	const results = await Promise.allSettled(
		channels.map(async ({ channelId, channelName }) => {
			const messages = await recentMessagesFetcher(channelId);
			return { channelName, messages };
		}),
	);
	const channelMessages = new Map(
		results
			.filter(
				(r): r is PromiseFulfilledResult<{ channelName: string; messages: RecentMessage[] }> =>
					r.status === "fulfilled",
			)
			.filter((r) => r.value.messages.length > 0)
			.map((r) => [r.value.channelName, r.value.messages] as const),
	);
	const context = formatRecentMessages(channelMessages);
	if (!context) return null;
	return { type: "text", text: context };
}

// ─── registerEventBufferTools ────────────────────────────────────

function buildMoodContent(moodReader: MoodReader | undefined, agentId: string): TextContent | null {
	if (!moodReader) return null;
	const mood = moodReader.getMood(agentId);
	if (isNeutralEmotion(mood)) return null;
	return {
		type: "text",
		text: `<current-mood>\n${describeEmotion(mood)}\nこれは直近の会話から推定されたあなたの現在の気分です。応答のトーンの参考にしてください。\n</current-mood>`,
	};
}

export function registerEventBufferTools(server: McpServer, deps: EventBufferDeps): void {
	const { db, agentId, recentMessagesFetcher, moodReader, typingSender } = deps;

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
				"イベントが届くまで待機し、届いたら最大10件まとめて消費して返す。直近のチャンネルメッセージがあれば別ブロックで付与する。対象チャンネルにはタイピングインジケーターを自動送信する。タイムアウト時は空配列を返す。",
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
				if (recentMessagesFetcher) {
					const ctx = await fetchRecentMessagesContext(events, recentMessagesFetcher);
					if (ctx) content.unshift(ctx);
				}
				const moodContent = buildMoodContent(moodReader, agentId);
				if (moodContent) content.unshift(moodContent);
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
			if (recentMessagesFetcher) {
				const ctx = await fetchRecentMessagesContext(result, recentMessagesFetcher);
				if (ctx) content.unshift(ctx);
			}
			const moodContent = buildMoodContent(moodReader, agentId);
			if (moodContent) content.unshift(moodContent);
			return { content };
		},
	);
}
