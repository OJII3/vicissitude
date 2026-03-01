import type {
	Event,
	EventMessagePartUpdated,
	EventQuestionAsked,
	EventSessionError,
	EventSessionIdle,
	OpencodeClient,
	QuestionAnswer,
	TextPart,
} from "@opencode-ai/sdk/v2";

import type { Logger } from "../../domain/ports/logger.port.ts";

type LoopState = {
	sessionId: string;
	status: "processing" | "waiting" | "idle";
	pendingQuestionId?: string;
	pendingEvents: string[];
	// partID → text
	textParts: Map<string, string>;
	resolveText?: (text: string) => void;
	rejectText?: (error: Error) => void;
};

export class SessionEventLoop {
	private loops = new Map<string, LoopState>();
	private sessionIdToKey = new Map<string, string>();

	constructor(
		private readonly client: OpencodeClient,
		private readonly logger: Logger,
	) {}

	async startEventStream(): Promise<void> {
		const { stream } = await this.client.event.subscribe();
		(async () => {
			try {
				for await (const event of stream) {
					this.handleEvent(event as Event);
				}
			} catch (err) {
				this.logger.error("SSE stream error", err);
			}
		})();
	}

	startPrompt(sessionKey: string, sessionId: string): Promise<string> {
		this.sessionIdToKey.set(sessionId, sessionKey);

		return new Promise<string>((resolve, reject) => {
			this.loops.set(sessionKey, {
				sessionId,
				status: "processing",
				pendingEvents: [],
				textParts: new Map(),
				resolveText: resolve,
				rejectText: reject,
			});
		});
	}

	feedEvent(sessionKey: string, content: string): void {
		const loop = this.loops.get(sessionKey);
		if (!loop) return;

		if (loop.status === "waiting" && loop.pendingQuestionId) {
			this.replyToQuestion(loop, content);
		} else {
			loop.pendingEvents.push(content);
		}
	}

	isWaiting(sessionKey: string): boolean {
		return this.loops.get(sessionKey)?.status === "waiting";
	}

	private handleEvent(event: Event): void {
		switch (event.type) {
			case "message.part.updated":
				this.handlePartUpdated(event as EventMessagePartUpdated);
				break;
			case "question.asked":
				this.handleQuestionAsked(event as EventQuestionAsked);
				break;
			case "session.idle":
				this.handleSessionIdle(event as EventSessionIdle);
				break;
			case "session.error":
				this.handleSessionError(event as EventSessionError);
				break;
		}
	}

	private handlePartUpdated(event: EventMessagePartUpdated): void {
		const part = event.properties.part;
		if (part.type !== "text") return;

		const textPart = part as TextPart;
		const sessionKey = this.sessionIdToKey.get(textPart.sessionID);
		if (!sessionKey) return;

		const loop = this.loops.get(sessionKey);
		if (!loop) return;

		loop.textParts.set(textPart.id, textPart.text);
	}

	private handleQuestionAsked(event: EventQuestionAsked): void {
		const { id, sessionID } = event.properties;
		const sessionKey = this.sessionIdToKey.get(sessionID);
		if (!sessionKey) return;

		const loop = this.loops.get(sessionKey);
		if (!loop) return;

		loop.status = "waiting";
		loop.pendingQuestionId = id;

		// テキスト応答を返す
		const text = this.collectText(loop);
		loop.resolveText?.(text);
		loop.resolveText = undefined;
		loop.rejectText = undefined;

		// キューにイベントがあれば即座に reply
		const nextEvent = loop.pendingEvents.shift();
		if (nextEvent !== undefined) {
			this.replyToQuestion(loop, nextEvent);
		}
	}

	private handleSessionIdle(event: EventSessionIdle): void {
		const sessionKey = this.sessionIdToKey.get(event.properties.sessionID);
		if (!sessionKey) return;

		const loop = this.loops.get(sessionKey);
		if (!loop) return;

		// question なしで終了（フォールバック）
		if (loop.status === "processing") {
			loop.status = "idle";
			const text = this.collectText(loop);
			loop.resolveText?.(text);
			loop.resolveText = undefined;
			loop.rejectText = undefined;
		}
	}

	private handleSessionError(event: EventSessionError): void {
		const sessionID = event.properties.sessionID;
		if (!sessionID) return;

		const sessionKey = this.sessionIdToKey.get(sessionID);
		if (!sessionKey) return;

		const loop = this.loops.get(sessionKey);
		if (!loop) return;

		const errorMsg = event.properties.error
			? JSON.stringify(event.properties.error)
			: "unknown session error";
		loop.rejectText?.(new Error(errorMsg));
		loop.resolveText = undefined;
		loop.rejectText = undefined;
		loop.status = "idle";
	}

	private replyToQuestion(loop: LoopState, content: string): void {
		if (!loop.pendingQuestionId) return;

		const requestID = loop.pendingQuestionId;
		loop.pendingQuestionId = undefined;
		loop.status = "processing";

		// テキスト収集をリセット
		loop.textParts.clear();

		// 新しい Promise を設定（次の応答を待つ）
		const textPromise = new Promise<string>((resolve, reject) => {
			loop.resolveText = resolve;
			loop.rejectText = reject;
		});

		const answers: QuestionAnswer[] = [[content]];
		void this.client.question.reply({ requestID, answers }).then(
			(result) => {
				if (result.error) {
					this.logger.error("question.reply failed", result.error);
					loop.rejectText?.(new Error(`question.reply failed: ${JSON.stringify(result.error)}`));
				}
				return result;
			},
			(err: unknown) => {
				this.logger.error("question.reply threw", err);
				loop.rejectText?.(new Error(`question.reply threw: ${String(err)}`));
			},
		);

		// textPromise は handleQuestionAsked / handleSessionIdle で resolve される
		void textPromise;
	}

	private collectText(loop: LoopState): string {
		const texts: string[] = [];
		for (const text of loop.textParts.values()) {
			if (text) texts.push(text);
		}
		return texts.join("\n") || "(no response)";
	}
}
