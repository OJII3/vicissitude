import { mock } from "bun:test";

import {
	DiscordAgent,
	type ConversationBreakConfig,
} from "@vicissitude/agent/discord/discord-agent";
import type { OpencodeSessionPort } from "@vicissitude/shared/types";

import { createMockLogger } from "../../test-helpers.ts";
import { createContextBuilder, createProfile, createSessionStore } from "../runner-test-helpers.ts";

// ─── テスト用 DiscordAgent サブクラス ─────────────────────────────

export class TestDiscordAgent extends DiscordAgent {
	sleepSpy: ((ms: number) => Promise<void>) | null = null;

	/** pendingCompaction フラグへの公開アクセス */
	get isPendingCompaction(): boolean {
		return (this as unknown as { pendingCompaction: boolean }).pendingCompaction;
	}

	/** lastActivityAt への公開アクセス */
	get currentLastActivityAt(): number | null {
		return (this as unknown as { lastActivityAt: number | null }).lastActivityAt;
	}

	/** lastChannelId への公開アクセス */
	get currentLastChannelId(): string | null {
		return (this as unknown as { lastChannelId: string | null }).lastChannelId;
	}

	/** compactionGapMs への公開アクセス */
	get currentCompactionGapMs(): number {
		return (this as unknown as { compactionGapMs: number }).compactionGapMs;
	}

	/** rotationGapMs への公開アクセス */
	get currentRotationGapMs(): number {
		return (this as unknown as { rotationGapMs: number }).rotationGapMs;
	}

	/** nowProvider への公開アクセス */
	get currentNowProvider(): () => number {
		return this.nowProvider;
	}

	readonly requestSessionRotationMock = mock((): Promise<void> => Promise.resolve());

	override requestSessionRotation(): Promise<void> {
		const result: Promise<void> = this.requestSessionRotationMock();
		return result;
	}

	/** テスト用: polling loop を起動しない（pendingCompaction フラグが消費されるのを防ぐ） */
	override ensurePolling(): void {}

	protected override sleep(ms: number): Promise<void> {
		if (this.sleepSpy) return this.sleepSpy(ms);
		return super.sleep(ms);
	}
}

// ─── ヘルパー ─────────────────────────────────────────────────────

export function createSessionPort(): OpencodeSessionPort {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => Promise.resolve({ type: "idle" as const })),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		deleteSession: mock(() => Promise.resolve()),
		summarizeSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort;
}

export function createAgent(
	opts: {
		nowProvider?: () => number;
		conversationBreak?: ConversationBreakConfig;
	} = {},
): TestDiscordAgent {
	const agent = new TestDiscordAgent({
		guildId: "guild-1",
		profile: createProfile(),
		sessionStore: createSessionStore() as never,
		contextBuilder: createContextBuilder(),
		logger: createMockLogger(),
		sessionPort: createSessionPort(),
		sessionMaxAgeMs: 86_400_000,
		nowProvider: opts.nowProvider,
		conversationBreak: opts.conversationBreak,
	});
	agent.sleepSpy = () => Promise.resolve();
	return agent;
}
