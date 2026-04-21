/**
 * spec/agent/ 配下の AgentRunner 系 spec で共通利用されるテストヘルパー。
 *
 * `spec/test-helpers.ts` は `createMockLogger` / `createMockMetrics` など汎用ヘルパー担当で、
 * AgentRunner 固有の mock は本ファイルに集約する。
 */
import { mock } from "bun:test";

import { AgentRunner, type RunnerDeps } from "@vicissitude/agent/runner";
import type { ContextBuilderPort } from "@vicissitude/shared/types";

import type { AgentProfile } from "../../packages/agent/src/profile.ts";

/**
 * `AgentRunner` のサブクラス。`sleep` を差し替え可能にすることでテストの待機を制御する。
 */
export class TestAgent extends AgentRunner {
	sleepSpy: ((ms: number) => Promise<void>) | null = null;
	enableDebounce = false;

	// oxlint-disable-next-line no-useless-constructor -- protected → public に昇格させるために必要
	constructor(deps: RunnerDeps) {
		super(deps);
	}

	protected override sleep(ms: number): Promise<void> {
		if (this.sleepSpy) return this.sleepSpy(ms);
		return super.sleep(ms);
	}

	protected override waitForDebounce(_signal: AbortSignal): Promise<void> {
		if (this.enableDebounce) return super.waitForDebounce(_signal);
		return Promise.resolve();
	}
}

export function deferred<T>() {
	let resolveDeferred!: (value: T) => void;
	let rejectDeferred!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolveDeferred = resolve;
		rejectDeferred = reject;
	});
	return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

export function createProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		name: "conversation",
		mcpServers: {},
		builtinTools: {},
		pollingPrompt: "loop forever",
		model: { providerId: "test-provider", modelId: "test-model" },
		...overrides,
	};
}

export function createContextBuilder(): ContextBuilderPort {
	return { build: mock(() => Promise.resolve("system prompt")) };
}

export function createSessionStore(existingSessionId?: string) {
	let sessionId: string | undefined = existingSessionId;
	const createdAt: number | undefined = existingSessionId ? Date.now() : undefined;
	return {
		get: mock(() => sessionId),
		getRow: mock(() => (sessionId && createdAt ? { key: "k", sessionId, createdAt } : undefined)),
		save: mock((_profile: string, _key: string, nextSessionId: string) => {
			sessionId = nextSessionId;
		}),
		delete: mock(() => {
			sessionId = undefined;
		}),
	};
}

export function neverResolve(_signal: AbortSignal): Promise<void> {
	return new Promise(() => {});
}
