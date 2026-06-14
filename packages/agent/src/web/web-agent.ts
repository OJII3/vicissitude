import { abortReasonToError, escapeUserMessageTag, raceAbort } from "@vicissitude/shared/functions";
import { agentScopeNamespace } from "@vicissitude/shared/namespace";
import type {
	AgentResponse,
	ContextBuilderPort,
	ConversationRecorder,
	Logger,
	OpencodeSessionPort,
	SessionStorePort,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "../profile.ts";

export const WEB_AGENT_ID = "web:local";
export const WEB_SCOPE_ID = "web:local";
export const WEB_PROMPT_TIMEOUT_MS = 120_000;
const WEB_SESSION_KEY = "__web__:web:local";
const WEB_USER_ID = "web:user";
const WEB_ASSISTANT_ID = "web:assistant";

interface ConversationRecordInput {
	role: "user" | "assistant";
	content: string;
	authorId: string;
	name: string;
	timestamp: string;
}

export interface WebConversationRequest {
	connectionId: string;
	text: string;
	timestamp: string;
	signal?: AbortSignal;
}

export interface WebConversationAgentDeps {
	agentId: string;
	scopeId: string;
	sessionStore: SessionStorePort;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	sessionPort: OpencodeSessionPort;
	sessionMaxAgeMs: number;
	profile: AgentProfile;
	recorder?: ConversationRecorder;
	nowProvider?: () => number;
	promptTimeoutMs?: number;
}

export class WebConversationAgent {
	private readonly agentId: string;
	private readonly scopeId: string;
	private readonly sessionStore: SessionStorePort;
	private readonly contextBuilder: ContextBuilderPort;
	private readonly logger: Logger;
	private readonly sessionPort: OpencodeSessionPort;
	private readonly sessionMaxAgeMs: number;
	private readonly profile: AgentProfile;
	private readonly recorder?: ConversationRecorder;
	private readonly nowProvider: () => number;
	private readonly promptTimeoutMs: number;
	private hasInjectedSystem = false;
	private queue: Promise<void> = Promise.resolve();

	constructor(deps: WebConversationAgentDeps) {
		this.agentId = deps.agentId;
		this.scopeId = deps.scopeId;
		this.sessionStore = deps.sessionStore;
		this.contextBuilder = deps.contextBuilder;
		this.logger = deps.logger;
		this.sessionPort = deps.sessionPort;
		this.sessionMaxAgeMs = deps.sessionMaxAgeMs;
		this.profile = deps.profile;
		this.recorder = deps.recorder;
		this.nowProvider = deps.nowProvider ?? Date.now;
		this.promptTimeoutMs = deps.promptTimeoutMs ?? WEB_PROMPT_TIMEOUT_MS;
	}

	respond(request: WebConversationRequest): Promise<AgentResponse> {
		return this.enqueue(() => this.respondNow(request));
	}

	stop(): void {
		this.sessionPort.close();
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		const run = (async () => {
			try {
				await previous;
			} catch {
				// queue の継続だけが目的なので、前回失敗は呼び出し元の Promise にだけ伝える
			}
			return task();
		})();
		this.queue = (async () => {
			try {
				await run;
			} catch {
				// 次の Web 入力を詰まらせない
			}
		})();
		return run;
	}

	private async respondNow(request: WebConversationRequest): Promise<AgentResponse> {
		if (request.signal?.aborted) {
			throw new DOMException("Web conversation request aborted", "AbortError");
		}

		await this.record({
			role: "user",
			content: request.text,
			authorId: WEB_USER_ID,
			name: "Web User",
			timestamp: request.timestamp,
		});
		const sessionId = await this.resolveSessionId();
		const turnPromptPrefix = await this.contextBuilder.buildTurnPromptPrefix?.();
		const promptText = [
			turnPromptPrefix,
			this.profile.pollingPrompt,
			this.formatUserMessage(request),
		]
			.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
			.join("\n\n");
		const system = this.hasInjectedSystem
			? undefined
			: await this.contextBuilder.build(this.scopeId);

		this.logger.info(`[${this.profile.name}:${this.agentId}] prompting Web session ${sessionId}`);
		const promptSignal = createPromptSignal(request.signal, this.promptTimeoutMs);
		if (promptSignal.aborted) throw abortReasonToError(promptSignal);
		const result = await raceAbort(
			this.sessionPort.prompt(
				{
					sessionId,
					text: promptText,
					model: this.profile.model,
					system,
				},
				promptSignal,
			),
			promptSignal,
		);
		this.hasInjectedSystem = true;

		await this.record({
			role: "assistant",
			content: result.text,
			authorId: WEB_ASSISTANT_ID,
			name: "ふあ",
			timestamp: new Date().toISOString(),
		});
		return { text: result.text, sessionId, tokens: result.tokens };
	}

	private async resolveSessionId(): Promise<string> {
		const row = this.sessionStore.getRow(this.profile.name, WEB_SESSION_KEY);
		if (row) {
			const expired = this.nowProvider() - row.createdAt >= this.sessionMaxAgeMs;
			if (!expired && (await this.sessionPort.sessionExists(row.sessionId))) {
				return row.sessionId;
			}
			this.sessionStore.delete(this.profile.name, WEB_SESSION_KEY);
			this.hasInjectedSystem = false;
		}

		const sessionId = await this.sessionPort.createSession(this.agentId);
		this.sessionStore.save(this.profile.name, WEB_SESSION_KEY, sessionId);
		this.hasInjectedSystem = false;
		return sessionId;
	}

	private formatUserMessage(request: WebConversationRequest): string {
		const escaped = escapeUserMessageTag(request.text);
		return `<web_message connection_id="${request.connectionId}" timestamp="${request.timestamp}">
<user_message>${escaped}</user_message>
</web_message>`;
	}

	private async record(input: ConversationRecordInput): Promise<void> {
		if (!this.recorder || !input.content.trim()) return;
		try {
			await this.recorder.record(agentScopeNamespace(this.scopeId), {
				role: input.role,
				content: input.content,
				name: input.name,
				authorId: input.authorId,
				timestamp: new Date(input.timestamp),
			});
		} catch (error) {
			this.logger.warn("[web-agent] failed to record conversation", { error });
		}
	}
}

function createPromptSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}
