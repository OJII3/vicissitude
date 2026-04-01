/* oxlint-disable no-non-null-assertion -- test assertions after length/null checks */
import { describe, expect, test } from "bun:test";

import { createEmotion } from "@vicissitude/shared/emotion";
import type { Emotion } from "@vicissitude/shared/emotion";
import type {
	EmotionAnalysisInput,
	EmotionAnalysisResult,
	EmotionAnalyzer,
	MoodWriter,
} from "@vicissitude/shared/ports";

import { captureTools, createDiscordClientStub } from "./_discord-helpers";

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

// ─── Tests ───────────────────────────────────────────────────────

describe("send_message / reply での感情推定トリガー", () => {
	test("send_message 呼び出し時に EmotionAnalyzer.analyze() がエージェントの応答テキストで呼ばれる", async () => {
		const { analyzer, calls: analyzerCalls } = createSpyEmotionAnalyzer();
		const { writer } = createSpyMoodWriter();

		const { tools } = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: writer,
			agentId: "agent-1",
		});

		const sendMessage = tools.get("send_message");
		expect(sendMessage).toBeDefined();

		await sendMessage!({ channel_id: "ch-1", content: "こんにちは！元気だよ" });

		// analyze が呼ばれ、入力テキストがエージェントの応答テキストであること
		expect(analyzerCalls).toHaveLength(1);
		expect(analyzerCalls[0]!.text).toBe("こんにちは！元気だよ");
	});

	test("reply 呼び出し時に EmotionAnalyzer.analyze() がエージェントの応答テキストで呼ばれる", async () => {
		const { analyzer, calls: analyzerCalls } = createSpyEmotionAnalyzer();
		const { writer } = createSpyMoodWriter();

		const { tools } = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: writer,
			agentId: "agent-1",
		});

		const reply = tools.get("reply");
		expect(reply).toBeDefined();

		await reply!({
			channel_id: "ch-1",
			message_id: "msg-1",
			content: "そうだね、楽しいね！",
		});

		expect(analyzerCalls).toHaveLength(1);
		expect(analyzerCalls[0]!.text).toBe("そうだね、楽しいね！");
	});

	test("推定結果が MoodWriter.setMood() で書き込まれる", async () => {
		const emotion = createEmotion(0.8, 0.5, 0.2);
		const { analyzer } = createSpyEmotionAnalyzer({ emotion, confidence: 0.85 });
		const { writer, calls: writerCalls } = createSpyMoodWriter();

		const { tools } = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: writer,
			agentId: "agent-1",
		});

		const sendMessage = tools.get("send_message");
		await sendMessage!({ channel_id: "ch-1", content: "嬉しい！" });

		// fire-and-forget なので少し待つ
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 50);
		});

		expect(writerCalls).toHaveLength(1);
		expect(writerCalls[0]!.agentId).toBe("agent-1");
		expect(writerCalls[0]!.emotion).toEqual(emotion);
	});

	test("confidence が 0 の場合は MoodWriter.setMood() が呼ばれない", async () => {
		const { analyzer } = createSpyEmotionAnalyzer({
			emotion: createEmotion(0, 0, 0),
			confidence: 0,
		});
		const { writer, calls: writerCalls } = createSpyMoodWriter();

		const { tools } = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: writer,
			agentId: "agent-1",
		});

		const sendMessage = tools.get("send_message");
		await sendMessage!({ channel_id: "ch-1", content: "..." });

		await new Promise<void>((resolve) => {
			setTimeout(resolve, 50);
		});

		expect(writerCalls).toHaveLength(0);
	});

	test("emotionAnalyzer が未設定の場合はエラーなく動作する", async () => {
		const { tools } = captureTools({
			discordClient: createDiscordClientStub(),
			// emotionAnalyzer, moodWriter, agentId を渡さない
		});

		const sendMessage = tools.get("send_message");
		expect(sendMessage).toBeDefined();

		// エラーなく完了すること
		const result = (await sendMessage!({
			channel_id: "ch-1",
			content: "テスト",
		})) as { content: Array<{ type: string; text: string }> };

		expect(result.content).toBeDefined();
	});

	test("moodWriter が未設定の場合はエラーなく動作する（emotionAnalyzer のみ設定）", async () => {
		const { analyzer } = createSpyEmotionAnalyzer();

		const { tools } = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			agentId: "agent-1",
			// moodWriter を渡さない
		});

		const sendMessage = tools.get("send_message");

		const result = (await sendMessage!({
			channel_id: "ch-1",
			content: "テスト",
		})) as { content: Array<{ type: string; text: string }> };

		expect(result.content).toBeDefined();
	});

	test("moodKey が指定されている場合、setMood() は agentId ではなく moodKey をキーとして呼ばれる", async () => {
		const emotion = createEmotion(0.7, 0.3, 0.1);
		const { analyzer } = createSpyEmotionAnalyzer({ emotion, confidence: 0.9 });
		const { writer, calls: writerCalls } = createSpyMoodWriter();

		const { tools } = captureTools({
			discordClient: createDiscordClientStub(),
			emotionAnalyzer: analyzer,
			moodWriter: writer,
			agentId: "discord:heartbeat:12345",
			moodKey: "discord:12345",
		});

		const sendMessage = tools.get("send_message");
		await sendMessage!({ channel_id: "ch-1", content: "テスト" });

		// fire-and-forget なので少し待つ
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 50);
		});

		expect(writerCalls).toHaveLength(1);
		// moodKey が使われ、agentId ではないことを検証
		expect(writerCalls[0]!.agentId).toBe("discord:12345");
	});
});
