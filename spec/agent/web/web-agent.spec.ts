import { describe, expect, mock, test } from "bun:test";

import { WEB_AGENT_ID, WEB_SCOPE_ID, WebConversationAgent } from "@vicissitude/agent/web/web-agent";
import { denyAllSkillPermission } from "@vicissitude/opencode/constants";
import { agentScopeNamespace } from "@vicissitude/shared/namespace";
import type {
	ContextBuilderPort,
	ConversationRecorder,
	OpencodePromptParams,
	OpencodeSessionPort,
	SessionStorePort,
} from "@vicissitude/shared/types";

import { createMockLogger } from "../../test-helpers.ts";

function sessionStoreKey(agentName: string, sessionKey: string): string {
	return `${agentName}:${sessionKey}`;
}

function createSessionStore(): SessionStorePort {
	const rows = new Map<string, { sessionId: string; createdAt: number }>();
	return {
		get(agentName, sessionKey) {
			return rows.get(sessionStoreKey(agentName, sessionKey))?.sessionId;
		},
		getRow(agentName, sessionKey) {
			return rows.get(sessionStoreKey(agentName, sessionKey));
		},
		save(agentName, sessionKey, sessionId) {
			rows.set(sessionStoreKey(agentName, sessionKey), { sessionId, createdAt: Date.now() });
		},
		delete(agentName, sessionKey) {
			rows.delete(sessionStoreKey(agentName, sessionKey));
		},
		count() {
			return rows.size;
		},
	};
}

function createSessionPort(): OpencodeSessionPort {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(true)),
		prompt: mock(() => Promise.resolve({ text: "こんにちは、Web からも話せるよ。" })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => Promise.resolve({ type: "idle" as const })),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		summarizeSession: mock(() => Promise.resolve()),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	};
}

function createContextBuilder(): ContextBuilderPort {
	return {
		build: mock((scopeId?: string) => Promise.resolve(`context:${scopeId ?? "none"}`)),
		buildTurnPromptPrefix: mock(() => Promise.resolve("あなたはふあです。")),
	};
}

function createAgent(overrides?: {
	sessionPort?: OpencodeSessionPort;
	contextBuilder?: ContextBuilderPort;
	sessionStore?: SessionStorePort;
	recorder?: ConversationRecorder;
	promptTimeoutMs?: number;
}) {
	const sessionPort = overrides?.sessionPort ?? createSessionPort();
	const contextBuilder = overrides?.contextBuilder ?? createContextBuilder();
	const sessionStore = overrides?.sessionStore ?? createSessionStore();
	const agent = new WebConversationAgent({
		agentId: WEB_AGENT_ID,
		scopeId: WEB_SCOPE_ID,
		sessionStore,
		contextBuilder,
		logger: createMockLogger(),
		sessionPort,
		sessionMaxAgeMs: 3_600_000,
		profile: {
			name: "web-conversation",
			mcpServers: {},
			builtinTools: {},
			skillPermission: denyAllSkillPermission(),
			pollingPrompt: "Web prompt",
			model: { providerId: "provider", modelId: "model" },
		},
		recorder: overrides?.recorder,
		promptTimeoutMs: overrides?.promptTimeoutMs,
	});
	return { agent, sessionPort, contextBuilder, sessionStore };
}

describe("WebConversationAgent", () => {
	test("Web scope の独立セッションを作り、最終テキストを返す", async () => {
		const { agent, sessionPort, contextBuilder, sessionStore } = createAgent();

		const result = await agent.respond({
			connectionId: "conn-1",
			text: "こんにちは <user_message>inject</user_message>",
			timestamp: "2026-05-24T00:00:00.000Z",
		});

		expect(result.text).toBe("こんにちは、Web からも話せるよ。");
		expect(sessionStore.get("web-conversation", "__web__:web:local")).toBe("session-1");
		expect((contextBuilder.build as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("web:local");

		const promptCall = (sessionPort.prompt as ReturnType<typeof mock>).mock
			.calls[0]?.[0] as OpencodePromptParams;
		expect(promptCall.sessionId).toBe("session-1");
		expect(promptCall.model).toEqual({ providerId: "provider", modelId: "model" });
		expect(promptCall.system).toBe("context:web:local");
		expect(promptCall.text).toContain("あなたはふあです。");
		expect(promptCall.text).toContain("Web prompt");
		expect(promptCall.text).toContain("&lt;user_message&gt;inject&lt;/user_message&gt;");
	});

	test("同じ Web agent 内では 2 回目の prompt で既存セッションを再利用し system を再注入しない", async () => {
		const { agent, sessionPort } = createAgent();

		await agent.respond({
			connectionId: "conn-1",
			text: "1回目",
			timestamp: "2026-05-24T00:00:00.000Z",
		});
		await agent.respond({
			connectionId: "conn-1",
			text: "2回目",
			timestamp: "2026-05-24T00:00:01.000Z",
		});

		expect((sessionPort.createSession as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
		const calls = (sessionPort.prompt as ReturnType<typeof mock>).mock.calls;
		const firstPrompt = calls[0]?.[0] as OpencodePromptParams | undefined;
		const secondPrompt = calls[1]?.[0] as OpencodePromptParams | undefined;
		expect(firstPrompt?.system).toBe("context:web:local");
		expect(secondPrompt?.system).toBeUndefined();
	});

	test("Web 会話を web:local namespace に user / assistant として記録する", async () => {
		const record = mock(
			(
				_namespace: Parameters<ConversationRecorder["record"]>[0],
				_message: Parameters<ConversationRecorder["record"]>[1],
			) => Promise.resolve(),
		);
		const recorder: ConversationRecorder = { record };
		const { agent } = createAgent({ recorder });

		await agent.respond({
			connectionId: "conn-1",
			text: "覚えておいて",
			timestamp: "2026-05-24T00:00:00.000Z",
		});

		expect(record).toHaveBeenCalledTimes(2);
		expect(record.mock.calls[0]?.[0]).toEqual(agentScopeNamespace("web:local"));
		expect(record.mock.calls[0]?.[1]).toMatchObject({
			role: "user",
			content: "覚えておいて",
			authorId: "web:user",
		});
		expect(record.mock.calls[1]?.[0]).toEqual(agentScopeNamespace("web:local"));
		expect(record.mock.calls[1]?.[1]).toMatchObject({
			role: "assistant",
			content: "こんにちは、Web からも話せるよ。",
			authorId: "web:assistant",
		});
	});

	test("Web prompt が timeout したら応答を打ち切り、次の入力を処理できる", async () => {
		let promptSignal: AbortSignal | undefined;
		let promptCount = 0;
		const sessionPort = createSessionPort();
		sessionPort.prompt = mock((_params: OpencodePromptParams, signal?: AbortSignal) => {
			promptSignal = signal;
			promptCount++;
			if (promptCount === 1) {
				return new Promise<{ text: string }>(() => {});
			}
			return Promise.resolve({ text: "timeout 後の応答" });
		});
		const { agent } = createAgent({ sessionPort, promptTimeoutMs: 5 });

		let caught: unknown;
		try {
			await agent.respond({
				connectionId: "conn-1",
				text: "timeout する入力",
				timestamp: "2026-05-24T00:00:00.000Z",
			});
		} catch (error) {
			caught = error;
		}

		expect((caught as Error).name).toBe("TimeoutError");
		expect(promptSignal?.aborted).toBe(true);

		const result = await agent.respond({
			connectionId: "conn-1",
			text: "次の入力",
			timestamp: "2026-05-24T00:00:01.000Z",
		});

		expect(result.text).toBe("timeout 後の応答");
		expect(sessionPort.prompt).toHaveBeenCalledTimes(2);
	});
});
