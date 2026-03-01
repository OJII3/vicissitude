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
	textParts: Map<string, string>;
	resolveText?: (text: string) => void;
	rejectText?: (error: Error) => void;
};

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;

export class SessionEventLoop {
	private loops = new Map<string, LoopState>();
	private sessionIdToKey = new Map<string, string>();
	private abortController: AbortController | null = null;

	constructor(
		private readonly client: OpencodeClient,
		private readonly logger: Logger,
	) {}

	startEventStream(): void {
		this.abortController = new AbortController();
		this.runEventStreamLoop(this.abortController.signal);
	}

	stop(): void {
		this.abortController?.abort();
		this.abortController = null;
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

	awaitNextResponse(sessionKey: string): Promise<string> {
		const loop = this.loops.get(sessionKey);
		if (!loop) {
			return Promise.reject(new Error(`No loop state for session key: ${sessionKey}`));
		}

		return new Promise<string>((resolve, reject) => {
			loop.resolveText = resolve;
			loop.rejectText = reject;
			loop.textParts.clear();
			loop.status = "processing";
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

	private runEventStreamLoop(signal: AbortSignal): void {
		let delay = INITIAL_RECONNECT_DELAY_MS;

		const connect = async () => {
			while (!signal.aborted) {
				try {
					// eslint-disable-next-line no-await-in-loop -- sequential reconnect is intentional
					const { stream } = await this.client.event.subscribe();
					delay = INITIAL_RECONNECT_DELAY_MS;

					// eslint-disable-next-line no-await-in-loop -- consuming SSE stream sequentially
					for await (const event of stream) {
						if (signal.aborted) return;
						this.handleEvent(event as Event);
					}
				} catch (err) {
					if (signal.aborted) return;
					this.logger.error("SSE stream error, rejecting pending loops", err);
					this.rejectAllPendingLoops(new Error(`SSE stream disconnected: ${String(err)}`));
				}

				if (signal.aborted) return;

				this.logger.info(`SSE reconnecting in ${delay}ms...`);
				// eslint-disable-next-line no-await-in-loop -- backoff delay between reconnects
				await this.sleep(delay, signal);
				delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
			}
		};

		connect().catch((err: unknown) => {
			this.logger.error("SSE event stream loop failed unexpectedly", err);
		});
	}

	private sleep(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					done();
				},
				{ once: true },
			);
		});
	}

	private rejectAllPendingLoops(error: Error): void {
		for (const [sessionKey, loop] of this.loops) {
			if (loop.status === "processing" || loop.status === "waiting") {
				loop.rejectText?.(error);
				this.cleanup(sessionKey, loop);
			}
		}
	}

	private cleanup(sessionKey: string, loop: LoopState): void {
		this.loops.delete(sessionKey);
		this.sessionIdToKey.delete(loop.sessionId);
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

		const text = this.collectText(loop);
		loop.resolveText?.(text);
		loop.resolveText = undefined;
		loop.rejectText = undefined;

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

		if (loop.status === "processing" || loop.status === "waiting") {
			loop.status = "idle";
			const text = this.collectText(loop);
			loop.resolveText?.(text);
			loop.resolveText = undefined;
			loop.rejectText = undefined;
			this.cleanup(sessionKey, loop);
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
		this.cleanup(sessionKey, loop);
	}

	private replyToQuestion(loop: LoopState, content: string): void {
		if (!loop.pendingQuestionId) return;

		const requestID = loop.pendingQuestionId;
		loop.pendingQuestionId = undefined;
		loop.status = "processing";

		loop.textParts.clear();

		const textPromise = new Promise<string>((resolve, reject) => {
			loop.resolveText = resolve;
			loop.rejectText = reject;
		});

		const answers: QuestionAnswer[] = [[content]];
		this.client.question
			.reply({ requestID, answers })
			.then((result) => {
				if (result.error) {
					this.logger.error("question.reply failed", result.error);
					loop.rejectText?.(new Error(`question.reply failed: ${JSON.stringify(result.error)}`));
				}
				return result;
			})
			.catch((err: unknown) => {
				this.logger.error("question.reply threw", err);
				loop.rejectText?.(new Error(`question.reply threw: ${String(err)}`));
			});

		textPromise.catch(() => {});
	}

	private collectText(loop: LoopState): string {
		const texts: string[] = [];
		for (const text of loop.textParts.values()) {
			if (text) texts.push(text);
		}
		return texts.join("\n") || "(no response)";
	}
}
