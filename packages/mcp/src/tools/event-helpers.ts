import type { Attachment } from "@vicissitude/shared/types";

/** 一度に消費するイベントの最大件数 */
export const MAX_BATCH_SIZE = 10;

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
		[key: string]: unknown;
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

export { escapeUserMessageTag } from "@vicissitude/shared/functions";

// ─── isErrorEvent ───────────────────���────────────────────────────

/** parseEvents がパースに失敗したエラーイベントかどうかを判定する type guard */
export function isErrorEvent(e: EventOrError): e is ErrorEvent {
	return "_error" in e && "_raw" in e;
}
