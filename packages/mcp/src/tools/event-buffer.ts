/**
 * ポーリングモデル（半無限セッション）
 *
 * Copilot はリクエスト単位のチケット制課金のため、1回の promptAsync で LLM セッションを起動し、
 * LLM 自身が wait_for_events MCP ツールを繰り返し呼び出すことでセッションを終了させずに
 * 半永続的に動作させる。追加のプロンプト送信なしでイベント駆動の応答を実現する。
 *
 *   promptAsync → LLM: wait_for_events() ──timeout──→ wait_for_events()
 *                        ├─ events arrive → respond ──→ wait_for_events()
 *                        └─ (このループが半永続的に続く)
 *
 * core MCP は stdio (local) モードで動作し、OpenCode がエージェントごとに子プロセスとして
 * core-server.js を起動する。AGENT_ID 環境変数で wait_for_events のバインド先を指定する。
 *
 * @module
 */
/* oxlint-disable max-lines -- event-buffer tools + polling + formatting helpers are tightly coupled */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { METRIC } from "@vicissitude/observability/metrics";
import { describeEmotion, isNeutralEmotion } from "@vicissitude/shared/emotion";
import { formatTimestamp } from "@vicissitude/shared/functions";
import type { MoodReader } from "@vicissitude/shared/ports";
import type { Attachment, Logger, MetricsCollector } from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { consumeEvents, hasEvents, touchHeartbeat } from "@vicissitude/store/queries";
import { z } from "zod";

export interface RecentMessage {
	authorName: string;
	content: string;
	timestamp: Date;
	reactions: { emoji: string; count: number }[];
}

/** チャンネルIDを受け取り直近メッセージ一覧を返すポート */
export type RecentMessagesFetcher = (channelId: string) => Promise<RecentMessage[]>;

export interface EventBufferDeps {
	db: StoreDb;
	agentId: string;
	moodKey?: string;
	recentMessagesFetcher?: RecentMessagesFetcher;
	moodReader?: MoodReader;
	logger?: Logger;
	metrics?: Pick<MetricsCollector, "incrementCounter">;
}

/** 一度に消費するイベントの最大件数。LLM が確実に処理できる範囲に制限する。 */
export const MAX_BATCH_SIZE = 10;

/** wait_for_events の timeout_seconds 上限（秒）。 */
export const MAX_POLL_TIMEOUT_SECONDS = 200;

// ─── ActionHint ──────────────────────────────────────────────────

export type ActionHint = "respond" | "optional" | "read_only" | "internal";

// ─── ParsedEvent / ErrorEvent ────────────────────────────────────

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

export interface ErrorEvent {
	_raw: string;
	_error: string;
}

export type EventOrError = ParsedEvent | ErrorEvent;

// ─── parseEvents ─────────────────────────────────────────────────

/** payload 文字列の配列をパースして EventOrError 配列を返す。不正 JSON は ErrorEvent として返す */
export function parseEvents(rows: { payload: string }[]): EventOrError[] {
	return rows.map((r) => {
		try {
			return JSON.parse(r.payload) as ParsedEvent;
		} catch {
			return { _raw: r.payload, _error: "invalid JSON" };
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

/** parseEvents がパースに失敗したエラーイベントかどうかを判定する type guard */
export function isErrorEvent(e: EventOrError): e is ErrorEvent {
	return "_error" in e && "_raw" in e;
}

/** EventOrError 配列を人間可読形式にフォーマットする */
export function formatEvents(events: EventOrError[]): string {
	if (events.length === 0) return "";

	return events
		.map((e) => {
			// エラーイベント
			if (isErrorEvent(e)) {
				return `[ERROR] ${e._error}: ${e._raw}`;
			}

			const dateStr = formatTimestamp(new Date(e.ts));
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
export function formatEventMetadata(events: EventOrError[]): string {
	if (events.length === 0) return "";

	const parsed = events.filter((e): e is ParsedEvent => !isErrorEvent(e));
	if (parsed.length === 0) return "";

	const metadata = parsed.map((e) => ({
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
			const dateStr = formatTimestamp(msg.timestamp);
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

// ─── pollEvents ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

export interface PollOptions {
	pollIntervalMs?: number;
	onPoll?: () => void;
	logger?: Logger;
	metrics?: Pick<MetricsCollector, "incrementCounter">;
}

export async function pollEvents(
	db: StoreDb,
	agentId: string,
	deadlineMs: number,
	options?: PollOptions,
): Promise<EventOrError[] | null> {
	const { pollIntervalMs = 1000, onPoll, logger: pollLogger } = options ?? {};
	while (Date.now() < deadlineMs) {
		onPoll?.();
		try {
			if (hasEvents(db, agentId)) {
				const rows = consumeEvents(db, agentId, MAX_BATCH_SIZE);
				if (rows.length > 0) return parseEvents(rows);
			}
		} catch (err) {
			pollLogger?.error("[event-buffer] pollEvents error during hasEvents/consumeEvents", err);
			options?.metrics?.incrementCounter(METRIC.EVENT_BUFFER_POLL_ERRORS, { agent_id: agentId });
		}
		// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
		await sleep(pollIntervalMs);
	}
	return null;
}

// ─── fetchRecentMessagesContext ──────────────────────────────────

type TextContent = { type: "text"; text: string };

/** EventOrError 配列からユニークな channelId + channelName ペアを抽出する（全イベント対象） */
function extractAllChannels(events: EventOrError[]): { channelId: string; channelName: string }[] {
	const seen = new Map<string, string>();
	for (const e of events) {
		if (isErrorEvent(e)) continue;
		const { channelId, channelName } = e.metadata ?? {};
		if (channelId && channelName && !seen.has(channelId)) {
			seen.set(channelId, channelName);
		}
	}
	return [...seen.entries()].map(([channelId, channelName]) => ({ channelId, channelName }));
}

async function fetchRecentMessagesContext(
	events: EventOrError[],
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

const HINT_PRIORITY: Record<ActionHint, number> = {
	respond: 3,
	optional: 2,
	read_only: 1,
	internal: 0,
};

/** EventOrError 配列から最も優先度の高い ActionHint を返す */
export function highestPriorityHint(events: EventOrError[]): ActionHint {
	let best: ActionHint = "internal";
	for (const e of events) {
		if (isErrorEvent(e)) continue;
		const hint = classifyActionHint(e);
		if (HINT_PRIORITY[hint] > HINT_PRIORITY[best]) {
			best = hint;
		}
	}
	return best;
}

/** 文字列配列の各値の出現回数を返す */
function countValues(values: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
	return counts;
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
	const { db, agentId, recentMessagesFetcher, moodReader, logger } = deps;
	const moodKey = deps.moodKey ?? agentId;

	/** イベント配列から応答コンテンツを組み立てる共通処理 */
	async function buildResponseContent(events: EventOrError[]): Promise<{ content: TextContent[] }> {
		const text = formatEvents(events);
		const metadataText = formatEventMetadata(events);
		const content: TextContent[] = [
			{ type: "text", text: text + (metadataText ? `\n${metadataText}` : "") },
		];
		if (recentMessagesFetcher) {
			const ctx = await fetchRecentMessagesContext(events, recentMessagesFetcher);
			if (ctx) content.unshift(ctx);
		}
		const moodContent = buildMoodContent(moodReader, moodKey);
		if (moodContent) content.unshift(moodContent);
		return { content };
	}

	server.registerTool(
		"wait_for_events",
		{
			description: `Wait for incoming events, consuming up to 10 at once. Returns recent channel messages in a separate block if available. Returns an empty result on timeout. On connection errors, call this tool again immediately WITHOUT generating any text or commentary. Max timeout_seconds is ${MAX_POLL_TIMEOUT_SECONDS}s.`,
			inputSchema: {
				timeout_seconds: z
					.number()
					.min(1)
					.max(MAX_POLL_TIMEOUT_SECONDS)
					.default(MAX_POLL_TIMEOUT_SECONDS),
			},
		},
		async ({ timeout_seconds }) => {
			touchHeartbeat(db, agentId);

			const immediate = consumeEvents(db, agentId, MAX_BATCH_SIZE);
			if (immediate.length > 0) {
				const events = parseEvents(immediate);
				const hints = events.map((e) => (isErrorEvent(e) ? "error" : classifyActionHint(e)));
				logger?.info(
					`[event-buffer] ${events.length}件のイベントを即時消費 (hints=${JSON.stringify(countValues(hints))})`,
				);
				return buildResponseContent(events);
			}

			const HEARTBEAT_INTERVAL_MS = 30_000;
			let lastHeartbeatAt = Date.now();
			const onPoll = () => {
				const now = Date.now();
				if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
					touchHeartbeat(db, agentId);
					lastHeartbeatAt = now;
				}
			};

			const deadline = Date.now() + timeout_seconds * 1000;
			const result = await pollEvents(db, agentId, deadline, {
				onPoll,
				logger,
				metrics: deps.metrics,
			});
			if (result === null) {
				logger?.debug(`[event-buffer] タイムアウト (${timeout_seconds}s)`);
				return { content: [{ type: "text" as const, text: "No events (timeout)" }] };
			}
			const hints = result.map((e) => (isErrorEvent(e) ? "error" : classifyActionHint(e)));
			logger?.info(
				`[event-buffer] ${result.length}件のイベントをポーリング消費 (hints=${JSON.stringify(countValues(hints))})`,
			);
			return buildResponseContent(result);
		},
	);
}
