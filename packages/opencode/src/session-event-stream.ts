import type { Event } from "@opencode-ai/sdk/v2";
import type {
	Logger,
	OpencodeSessionActivity,
	OpencodeSessionEvent,
	TokenUsage,
} from "@vicissitude/shared/types";

import {
	type AbortableAsyncStream,
	classifyEvent,
	extractPartActivity,
	logPartActivity,
	nextStreamEvent,
	sumTokens,
} from "./stream-helpers.ts";

/**
 * 2つのイベント監視ループ（promptAsyncAndWatchSession / waitForSessionIdle）で共有する
 * ログ挙動の差分を吸収するための設定。
 */
export interface SessionEventStreamLogConfig {
	/** ログ文言に付与するプレフィックス（promptAsync 版: "", waitIdle 版: "waitIdle: "） */
	readonly prefix: string;
	/** 分類成功イベント（idle 等）を info ログに出すか（promptAsync 版のみ true） */
	readonly logClassifiedSuccess: boolean;
}

export interface ConsumeSessionEventStreamParams {
	stream: AbortableAsyncStream<unknown>;
	signal: AbortSignal | undefined;
	sessionId: string;
	/** abort 検知時に呼ぶコールバック（session.abort 等。stream の subscribe/return とは別） */
	onAbort: () => Promise<void>;
	/** assistant メッセージのトークンを蓄積する Map。呼び出し側が所有する */
	tokensByMessage: Map<string, TokenUsage>;
	onActivity?: (activity: OpencodeSessionActivity) => void;
	logger?: Logger;
	log: SessionEventStreamLogConfig;
}

/**
 * OpenCode のイベントストリームを逐次消費し、終端イベント
 * （idle / error / cancelled / streamDisconnected / compacted / deleted）を返す。
 *
 * 責務分離:
 * - プロンプト送信（promptAsync）は呼び出し側が事前に行う。この関数は送信を含まない。
 * - ストリームの subscribe / returnStreamOnce は呼び出し側の責務。この関数は受信ループのみを担い、
 *   `stream` の所有権を持たない（呼び出し側が finally で returnStreamOnce する）。
 */
export async function consumeSessionEventStream(
	params: ConsumeSessionEventStreamParams,
): Promise<OpencodeSessionEvent> {
	const { stream, signal, sessionId, onAbort, tokensByMessage, onActivity, logger, log } = params;
	const p = log.prefix;
	let unclassifiedCount = 0;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- event stream must be consumed sequentially
		const event = await nextStreamEvent(stream, signal, onAbort);
		if (event.type === "aborted") {
			logger?.info(`[opencode] ${p}event stream aborted`);
			return { type: "cancelled" };
		}
		if (event.type === "done") {
			logger?.info(`[opencode] ${p}event stream done (idle)`);
			return { type: "idle", tokens: sumTokens(tokensByMessage) };
		}
		if (event.type === "streamTimeout") {
			logger?.warn(`[opencode] ${p}SSE stream disconnected: ${event.reason ?? "unknown"}`);
			return { type: "streamDisconnected", tokens: sumTokens(tokensByMessage) };
		}
		if (event.type === "streamError") {
			logger?.error(`[opencode] ${p}SSE stream error: ${event.reason}`);
			return { type: "streamDisconnected", tokens: sumTokens(tokensByMessage) };
		}
		const typed = event.value as Event;
		const rawType = typed.type;
		const props = "properties" in typed ? (typed.properties as Record<string, unknown>) : {};
		const eventSessionId = props?.sessionID as string | undefined;
		const msg = `[opencode] ${p}stream event: type=${rawType} eventSession=${eventSessionId ?? "?"} targetSession=${sessionId}`;
		if (rawType === "session.status" || rawType === "session.updated") {
			logger?.info(`${msg} props=${JSON.stringify(props)}`);
		} else {
			logger?.debug(msg);
		}

		logPartActivity(typed, sessionId, logger);
		const activity = extractPartActivity(typed, sessionId);
		if (activity) onActivity?.(activity);

		const classified = classifyEvent(typed, sessionId, tokensByMessage);
		if (classified) {
			if (classified.type === "error") {
				logger?.error(`[opencode] ${p}session.error event: ${classified.message ?? "unknown"}`);
			} else if (log.logClassifiedSuccess) {
				logger?.info(`[opencode] ${p}session event: ${classified.type}`);
			}
			return classified;
		}
		unclassifiedCount++;
		if (unclassifiedCount % 50 === 0) {
			logger?.info(
				`[opencode] ${p}${unclassifiedCount} unclassified events so far (last: type=${rawType} session=${eventSessionId ?? "?"})`,
			);
		}
	}
}
