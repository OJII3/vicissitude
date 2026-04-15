/* oxlint-disable max-lines -- event-buffer tools + polling + formatting helpers are tightly coupled */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { METRIC } from "@vicissitude/observability/metrics";
import { describeEmotion, isNeutralEmotion } from "@vicissitude/shared/emotion";
import { formatTimestamp } from "@vicissitude/shared/functions";
import type { MoodReader } from "@vicissitude/shared/ports";
import type { Attachment, Logger, MetricsCollector } from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import {
	consumeEvents,
	hasEvents,
	requestRotation,
	touchHeartbeat,
} from "@vicissitude/store/queries";
import { z } from "zod";

export interface RecentMessage {
	authorName: string;
	content: string;
	timestamp: Date;
	reactions: { emoji: string; count: number }[];
}

/** チャンネルIDを受け取り直近メッセージ一覧を返すポート */
export type RecentMessagesFetcher = (channelId: string) => Promise<RecentMessage[]>;

export interface SkipTracker {
	readonly pendingResponse: boolean;
	/** pending になった時刻（ms）。pending でなければ 0 */
	readonly pendingSince: number;
	/** 連続スキップ回数 */
	readonly consecutiveSkips: number;
	/** 連続で respond イベントがスキップされた回数 */
	readonly consecutiveRespondSkips: number;
	/** pending 中のイベントに含まれる最も優先度の高い ActionHint。pending でなければ null */
	readonly pendingHint: ActionHint | null;
	markPending(hint: ActionHint): void;
	/** スキップとして記録してから応答済みにする（consecutiveSkips はインクリメントされる） */
	markSkipped(): void;
	markResponded(): void;
}

export function createSkipTracker(): SkipTracker {
	const state = {
		pending: false,
		pendingSince: 0,
		consecutiveSkips: 0,
		consecutiveRespondSkips: 0,
		pendingHint: null as ActionHint | null,
	};
	return {
		get pendingResponse() {
			return state.pending;
		},
		get pendingSince() {
			return state.pendingSince;
		},
		get consecutiveSkips() {
			return state.consecutiveSkips;
		},
		get consecutiveRespondSkips() {
			return state.consecutiveRespondSkips;
		},
		get pendingHint() {
			return state.pendingHint;
		},
		markPending(hint: ActionHint) {
			state.pending = true;
			state.pendingSince = Date.now();
			state.pendingHint = hint;
		},
		markSkipped() {
			state.consecutiveSkips += 1;
			if (state.pendingHint === "respond") {
				state.consecutiveRespondSkips += 1;
			}
			state.pending = false;
			state.pendingSince = 0;
			state.pendingHint = null;
		},
		markResponded() {
			state.pending = false;
			state.pendingSince = 0;
			state.consecutiveSkips = 0;
			state.consecutiveRespondSkips = 0;
			state.pendingHint = null;
		},
	};
}

/** 連続 respond スキップでセッションローテーションを要求する閾値 */
export const RESPOND_SKIP_ROTATION_THRESHOLD = 2;

export interface EventBufferDeps {
	db: StoreDb;
	agentId: string;
	moodKey?: string;
	recentMessagesFetcher?: RecentMessagesFetcher;
	moodReader?: MoodReader;
	logger?: Logger;
	skipTracker?: SkipTracker;
	metrics?: Pick<MetricsCollector, "incrementCounter">;
}

/** 一度に消費するイベントの最大件数。LLM が確実に処理できる範囲に制限する。 */
export const MAX_BATCH_SIZE = 10;

/** wait_for_events の timeout_seconds 上限。Bun HTTP サーバーの idleTimeout 上限（255秒）未満に収める。 */
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
	const { db, agentId, recentMessagesFetcher, moodReader, logger, skipTracker } = deps;
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
		if (skipTracker) {
			const highestHint = highestPriorityHint(events);
			skipTracker.markPending(highestHint);
		}
		return { content };
	}

	server.registerTool(
		"wait_for_events",
		{
			description: `イベントが届くまで待機し、届いたら最大10件まとめて消費して返す。直近のチャンネルメッセージがあれば別ブロックで付与する。タイムアウト時は空配列を返す。timeout_seconds の上限は ${MAX_POLL_TIMEOUT_SECONDS} 秒。`,
			inputSchema: {
				timeout_seconds: z.number().min(1).max(MAX_POLL_TIMEOUT_SECONDS).default(60),
			},
		},
		async ({ timeout_seconds }) => {
			touchHeartbeat(db, agentId);

			if (skipTracker?.pendingResponse) {
				const elapsed = Date.now() - skipTracker.pendingSince;
				const skippedHint = skipTracker.pendingHint;
				skipTracker.markSkipped();
				const msg = `[event-buffer] 前回のイベントに対する応答がスキップされました (hint=${skippedHint}, 経過=${elapsed}ms, 連続スキップ=${skipTracker.consecutiveSkips}回, 連続respondスキップ=${skipTracker.consecutiveRespondSkips}回)`;
				if (skippedHint === "respond") {
					logger?.error(msg);
					if (skipTracker.consecutiveRespondSkips >= RESPOND_SKIP_ROTATION_THRESHOLD) {
						logger?.error(
							`[event-buffer] 連続respondスキップが閾値(${RESPOND_SKIP_ROTATION_THRESHOLD})に達しました。セッションローテーションを要求します`,
						);
						try {
							requestRotation(db, agentId);
						} catch (err) {
							logger?.error("[event-buffer] requestRotation failed", err);
						}
					}
				} else if (skipTracker.consecutiveSkips >= 3) {
					logger?.warn(msg);
				} else {
					logger?.info(msg);
				}
			}

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
				return { content: [{ type: "text" as const, text: "イベントなし（タイムアウト）" }] };
			}
			const hints = result.map((e) => (isErrorEvent(e) ? "error" : classifyActionHint(e)));
			logger?.info(
				`[event-buffer] ${result.length}件のイベントをポーリング消費 (hints=${JSON.stringify(countValues(hints))})`,
			);
			return buildResponseContent(result);
		},
	);
}
