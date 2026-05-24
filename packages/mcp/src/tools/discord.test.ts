/* oxlint-disable no-non-null-assertion -- test assertions after length/null checks */
import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createEmotion } from "@vicissitude/shared/emotion";
import type { Emotion } from "@vicissitude/shared/emotion";
import type {
	EmotionAnalysisInput,
	EmotionAnalysisResult,
	EmotionAnalyzer,
	MoodWriter,
} from "@vicissitude/shared/ports";
import { createMockLogger } from "@vicissitude/shared/test-helpers";
import { ChannelType } from "discord.js";

import { registerDiscordTools } from "./discord.ts";
import type { DiscordDeps, DiscordToolBounds } from "./discord.ts";

// ─── Test Helpers ────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function captureTools(deps: DiscordDeps, bounds?: DiscordToolBounds): Map<string, ToolHandler> {
	const tools = new Map<string, ToolHandler>();
	const fakeServer = {
		registerTool(name: string, _schema: unknown, handler: ToolHandler) {
			tools.set(name, handler);
		},
	} as unknown as McpServer;
	registerDiscordTools(fakeServer, deps, bounds);
	return tools;
}

function createDiscordClientStub(): DiscordDeps["discordClient"] {
	const sentMessage = { id: "sent-msg-1", reply: () => Promise.resolve({ id: "reply-msg-1" }) };
	return {
		channels: {
			cache: new Map(),
			fetch: () =>
				Promise.resolve({
					isTextBased: () => true,
					send: () => Promise.resolve(sentMessage),
					sendTyping: () => Promise.resolve(),
					messages: { fetch: () => Promise.resolve(sentMessage) },
				}),
		},
	} as unknown as DiscordDeps["discordClient"];
}

function createDmDiscordClientStub(recipientId: string): DiscordDeps["discordClient"] {
	const sentMessage = { id: "sent-msg-1", reply: () => Promise.resolve({ id: "reply-msg-1" }) };
	return {
		channels: {
			cache: new Map(),
			fetch: () =>
				Promise.resolve({
					type: ChannelType.DM,
					recipientId,
					send: () => Promise.resolve(sentMessage),
					sendTyping: () => Promise.resolve(),
					messages: { fetch: () => Promise.resolve(sentMessage) },
				}),
		},
	} as unknown as DiscordDeps["discordClient"];
}

function createSpyEmotionAnalyzer(result?: EmotionAnalysisResult): {
	analyzer: EmotionAnalyzer;
	calls: EmotionAnalysisInput[];
} {
	const calls: EmotionAnalysisInput[] = [];
	const defaultResult: EmotionAnalysisResult = result ?? {
		emotion: createEmotion(0.7, 0.3, 0.1),
		confidence: 0.9,
	};
	return {
		analyzer: {
			analyze(input: EmotionAnalysisInput): Promise<EmotionAnalysisResult> {
				calls.push(input);
				return Promise.resolve(defaultResult);
			},
		},
		calls,
	};
}

function createSpyMoodWriter(): {
	writer: MoodWriter;
	calls: Array<{ agentId: string; emotion: Emotion }>;
} {
	const calls: Array<{ agentId: string; emotion: Emotion }> = [];
	return {
		writer: {
			setMood(agentId: string, emotion: Emotion): void {
				calls.push({ agentId, emotion });
			},
		},
		calls,
	};
}

/** fire-and-forget の非同期処理が完了するまで待つ */
const tick = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 50);
	});

// ─── triggerEmotionEstimation 内部ロジック ───────────────────────

describe("triggerEmotionEstimation のエラーハンドリング", () => {
	test("emotionAnalyzer.analyze() がエラーを投げてもハンドラは正常に完了する", async () => {
		const failingAnalyzer: EmotionAnalyzer = {
			analyze(): Promise<EmotionAnalysisResult> {
				return Promise.reject(new Error("LLM connection failed"));
			},
		};
		const { writer, calls: writerCalls } = createSpyMoodWriter();
		const logger = createMockLogger();

		const tools = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: failingAnalyzer,
			moodWriter: writer,
			agentId: "agent-1",
			logger,
		});

		const sendMessage = tools.get("send_message")!;
		const result = (await sendMessage({ channel_id: "ch-1", content: "テスト" })) as {
			content: Array<{ type: string; text: string }>;
		};

		// ハンドラ自体は正常に完了する（エラーが握り潰される）
		expect(result.content[0]!.text).toContain("Sent message");

		await tick();
		// analyze() でエラーになるため setMood は呼ばれない
		expect(writerCalls).toHaveLength(0);
		expect(logger.warn).toHaveBeenCalledWith(
			"[discord] emotion estimation failed:",
			expect.any(Error),
		);
	});

	test("moodWriter.setMood() がエラーを投げてもハンドラは正常に完了する", async () => {
		const { analyzer } = createSpyEmotionAnalyzer();
		const throwingWriter: MoodWriter = {
			setMood(): void {
				throw new Error("Store write failed");
			},
		};
		const logger = createMockLogger();

		const tools = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: throwingWriter,
			agentId: "agent-1",
			logger,
		});

		const sendMessage = tools.get("send_message")!;
		const result = (await sendMessage({ channel_id: "ch-1", content: "テスト" })) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(result.content[0]!.text).toContain("Sent message");

		// エラーが伝播せず、プロセスがクラッシュしないことを確認
		await tick();
		expect(logger.warn).toHaveBeenCalledWith(
			"[discord] emotion estimation failed:",
			expect.any(Error),
		);
	});

	test("reply ハンドラでも analyze() エラーが握り潰される", async () => {
		const failingAnalyzer: EmotionAnalyzer = {
			analyze(): Promise<EmotionAnalysisResult> {
				return Promise.reject(new Error("LLM timeout"));
			},
		};
		const { writer, calls: writerCalls } = createSpyMoodWriter();

		const tools = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: failingAnalyzer,
			moodWriter: writer,
			agentId: "agent-1",
		});

		const reply = tools.get("reply")!;
		const result = (await reply({
			channel_id: "ch-1",
			message_id: "msg-1",
			content: "返信テスト",
		})) as { content: Array<{ type: string; text: string }> };

		expect(result.content[0]!.text).toContain("Replied with message");
		await tick();
		expect(writerCalls).toHaveLength(0);
	});
});

describe("triggerEmotionEstimation の分岐ロジック", () => {
	test("emotionAnalyzer が未設定なら analyze() は呼ばれない", async () => {
		const { writer, calls: writerCalls } = createSpyMoodWriter();

		const tools = captureTools({
			discordClient: createDiscordClientStub(),
			// emotionAnalyzer を渡さない
			moodWriter: writer,
			agentId: "agent-1",
		});

		await tools.get("send_message")!({ channel_id: "ch-1", content: "テスト" });
		await tick();

		expect(writerCalls).toHaveLength(0);
	});

	test("moodWriter が未設定なら analyze() は呼ばれない", async () => {
		const { analyzer, calls: analyzerCalls } = createSpyEmotionAnalyzer();

		const tools = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			// moodWriter を渡さない
			agentId: "agent-1",
		});

		await tools.get("send_message")!({ channel_id: "ch-1", content: "テスト" });
		await tick();

		// moodWriter が無いため early return し、analyze は呼ばれない
		expect(analyzerCalls).toHaveLength(0);
	});

	test("agentId が未設定なら analyze() は呼ばれない", async () => {
		const { analyzer, calls: analyzerCalls } = createSpyEmotionAnalyzer();
		const { writer, calls: writerCalls } = createSpyMoodWriter();

		const tools = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: writer,
			// agentId を渡さない
		});

		await tools.get("send_message")!({ channel_id: "ch-1", content: "テスト" });
		await tick();

		expect(analyzerCalls).toHaveLength(0);
		expect(writerCalls).toHaveLength(0);
	});

	test("confidence が 0 の場合は setMood() が呼ばれない", async () => {
		const { analyzer } = createSpyEmotionAnalyzer({
			emotion: createEmotion(0, 0, 0),
			confidence: 0,
		});
		const { writer, calls: writerCalls } = createSpyMoodWriter();

		const tools = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: writer,
			agentId: "agent-1",
		});

		await tools.get("send_message")!({ channel_id: "ch-1", content: "..." });
		await tick();

		expect(writerCalls).toHaveLength(0);
	});

	test("confidence > 0 の場合は setMood() が呼ばれる", async () => {
		const emotion = createEmotion(0.5, 0.4, 0.3);
		const { analyzer } = createSpyEmotionAnalyzer({ emotion, confidence: 0.01 });
		const { writer, calls: writerCalls } = createSpyMoodWriter();

		const tools = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: writer,
			agentId: "agent-1",
		});

		await tools.get("send_message")!({ channel_id: "ch-1", content: "テスト" });
		await tick();

		expect(writerCalls).toHaveLength(1);
		expect(writerCalls[0]!.agentId).toBe("agent-1");
		expect(writerCalls[0]!.emotion).toEqual(emotion);
	});
});

describe("DM bound tools", () => {
	test("boundDmUserId と一致する DM channel には送信できる", async () => {
		const tools = captureTools(
			{
				discordClient: createDmDiscordClientStub("111"),
				agentId: "discord:dm:111",
			},
			{ dmUserId: "111" },
		);

		const result = (await tools.get("send_message")!({
			channel_id: "dm-channel",
			content: "dm",
		})) as { content: Array<{ text: string }> };

		expect(result.content[0]!.text).toContain("Sent message");
	});

	test("boundDmUserId と一致しない DM channel には送信しない", () => {
		const tools = captureTools(
			{
				discordClient: createDmDiscordClientStub("222"),
				agentId: "discord:dm:111",
			},
			{ dmUserId: "111" },
		);

		expect(
			tools.get("send_message")!({
				channel_id: "dm-channel",
				content: "dm",
			}),
		).rejects.toThrow("not a DM channel for the bound user");
	});

	test("DM scope では guild_id を渡しても list_channels を使えない", async () => {
		const tools = captureTools(
			{
				discordClient: createDiscordClientStub(),
				agentId: "discord:dm:111",
			},
			{ dmUserId: "111" },
		);

		const result = (await tools.get("list_channels")!({
			guild_id: "guild-1",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("not available in DM scope");
	});
});
