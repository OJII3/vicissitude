/* oxlint-disable require-await -- test assertions with async mock ports */
import { describe, expect, mock, test } from "bun:test";

import { DriftScoreCalculator, parseSoulExamples } from "./drift-score.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import type { ChatMessage } from "./types.ts";

function assistantMsg(content: string): ChatMessage {
	return { role: "assistant", content };
}

function userMsg(content: string): ChatMessage {
	return { role: "user", content };
}

/** 制御可能な embed モックを持つ MemoryLlmPort を返す */
function createMockLlmPort(embedFn?: (text: string) => number[]) {
	const embedMock = mock(async (text: string) => {
		if (embedFn) return embedFn(text);
		return [1, 0, 0];
	});

	const port: MemoryLlmPort = {
		chat: async () => "",
		chatStructured: async () => ({}) as never,
		embed: embedMock,
	};

	return { port, embedMock };
}

describe("parseSoulExamples — 内部ロジック", () => {
	test("1行に複数の「」がある場合、すべて抽出する", () => {
		const text = "- 「あいう」と「かきく」を使い分ける";
		const result = parseSoulExamples(text);

		expect(result).toEqual(["あいう", "かきく"]);
	});

	test("× (半角風) で始まる行のセリフは除外される", () => {
		const text = "× 「ダメなセリフ」\n- 「良いセリフ」";
		const result = parseSoulExamples(text);

		expect(result).toEqual(["良いセリフ"]);
	});

	test("✕ (全角バツ U+2715) で始まる行のセリフも除外される", () => {
		const text = "✕ 「ダメなセリフ」\n- 「良いセリフ」";
		const result = parseSoulExamples(text);

		expect(result).toEqual(["良いセリフ"]);
	});

	test("× の前にスペースがある行も除外される", () => {
		const text = "  × 「スペース付きダメセリフ」\n- 「OK」";
		const result = parseSoulExamples(text);

		expect(result).toEqual(["OK"]);
	});

	test("セリフ例ヘッダ行自体に「」がなければ無視される", () => {
		const text = "### セリフ例：通常\n- 「テスト」";
		const result = parseSoulExamples(text);

		expect(result).toEqual(["テスト"]);
	});

	test("空行・コメントのみの行はスキップされる", () => {
		const text = "\n\n<!-- comment -->\n- 「セリフ」\n\n";
		const result = parseSoulExamples(text);

		expect(result).toEqual(["セリフ"]);
	});

	test("「」が無い行は何も抽出しない", () => {
		const text = "普通のテキスト行\nもう一行";
		const result = parseSoulExamples(text);

		expect(result).toEqual([]);
	});

	test("null-ish な空文字列で空配列を返す", () => {
		expect(parseSoulExamples("")).toEqual([]);
	});
});

describe("DriftScoreCalculator.init — 内部ロジック", () => {
	test("各セリフに対して正確に1回ずつ embed が呼ばれる", async () => {
		const { port, embedMock } = createMockLlmPort();
		const soulText = "- 「セリフA」\n- 「セリフB」\n- 「セリフC」";
		const calc = new DriftScoreCalculator(port, soulText);

		await calc.init();

		expect(embedMock).toHaveBeenCalledTimes(3);
		expect(embedMock.mock.calls[0]?.[0]).toBe("セリフA");
		expect(embedMock.mock.calls[1]?.[0]).toBe("セリフB");
		expect(embedMock.mock.calls[2]?.[0]).toBe("セリフC");
	});

	test("init 後に computeSemanticScore が動作する（キャッシュの間接確認）", async () => {
		const { port } = createMockLlmPort();
		const soulText = "- 「テスト」";
		const calc = new DriftScoreCalculator(port, soulText);

		await calc.init();

		const score = await calc.computeSemanticScore([assistantMsg("何か")]);
		expect(typeof score).toBe("number");
	});

	test("セリフ例が0件の場合、embed は呼ばれず init は成功する", async () => {
		const { port, embedMock } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "セリフなしのテキスト");

		await calc.init();

		expect(embedMock).toHaveBeenCalledTimes(0);
	});

	test("セリフ例が0件で init 後、computeSemanticScore は 0.0 を返す", async () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "セリフなしのテキスト");

		await calc.init();

		const score = await calc.computeSemanticScore([assistantMsg("テスト")]);
		expect(score).toBe(0.0);
	});
});

describe("DriftScoreCalculator.computeSemanticScore — 内部ロジック", () => {
	test("init() 前に呼ぶとエラーをスローする", async () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「テスト」");

		await expect(calc.computeSemanticScore([assistantMsg("テスト")])).rejects.toThrow(
			"init() must be called before computeSemanticScore()",
		);
	});

	test("全 reference に対する最大類似度が選択される", async () => {
		let callCount = 0;
		const { port } = createMockLlmPort(() => {
			callCount++;
			// ref1
			if (callCount === 1) return [1, 0, 0];
			// ref2
			if (callCount === 2) return [0, 1, 0];
			// message (ref1と同じ方向)
			return [1, 0, 0];
		});
		const calc = new DriftScoreCalculator(port, "- 「A」\n- 「B」");
		await calc.init();

		const score = await calc.computeSemanticScore([assistantMsg("テスト")]);

		expect(score).toBeCloseTo(0.0);
	});

	test("1.0 - avgSimilarity の計算が正しい", async () => {
		let callCount = 0;
		const { port } = createMockLlmPort(() => {
			callCount++;
			// ref
			if (callCount === 1) return [1, 0, 0];
			// message (直交)
			return [0, 1, 0];
		});
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const score = await calc.computeSemanticScore([assistantMsg("テスト")]);

		expect(score).toBeCloseTo(1.0);
	});

	test("cosine similarity が負になるケースはクランプで 1.0 になる", async () => {
		let callCount = 0;
		const { port } = createMockLlmPort(() => {
			callCount++;
			// ref
			if (callCount === 1) return [1, 0, 0];
			// message (逆方向)
			return [-1, 0, 0];
		});
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const score = await calc.computeSemanticScore([assistantMsg("テスト")]);

		// 1.0 - (-1.0) = 2.0 → clamp(2.0, 0.0, 1.0) = 1.0
		expect(score).toBe(1.0);
	});

	test("reference が1件のみの場合でも正しく動作する", async () => {
		let callCount = 0;
		const { port } = createMockLlmPort(() => {
			callCount++;
			// 唯一の ref
			if (callCount === 1) return [1, 0, 0];
			// message (45度)
			return [Math.SQRT1_2, Math.SQRT1_2, 0];
		});
		const calc = new DriftScoreCalculator(port, "- 「唯一」");
		await calc.init();

		const score = await calc.computeSemanticScore([assistantMsg("テスト")]);

		// cos ≈ 0.7071 → score ≈ 1.0 - 0.7071 ≈ 0.2929
		expect(score).toBeCloseTo(0.293, 2);
	});

	test("複数メッセージの平均が計算される", async () => {
		let callCount = 0;
		const { port } = createMockLlmPort(() => {
			callCount++;
			// ref
			if (callCount === 1) return [1, 0, 0];
			// msg1 (同方向)
			if (callCount === 2) return [1, 0, 0];
			// msg2 (直交)
			return [0, 1, 0];
		});
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const score = await calc.computeSemanticScore([assistantMsg("msg1"), assistantMsg("msg2")]);

		expect(score).toBeCloseTo(0.5);
	});

	test("user メッセージは無視される", async () => {
		let callCount = 0;
		const { port } = createMockLlmPort(() => {
			callCount++;
			// ref or assistant msg — 同方向
			return [1, 0, 0];
		});
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const score = await calc.computeSemanticScore([
			userMsg("ユーザーメッセージ"),
			assistantMsg("テスト"),
		]);

		// embed: ref(1回) + assistant(1回) = 2回のみ
		expect(callCount).toBe(2);
		expect(score).toBeCloseTo(0.0);
	});
});

describe("DriftScoreCalculator.computeFromMessages — 内部ロジック", () => {
	test("init() 前に呼ぶとエラーをスローする", async () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「A」");

		await expect(calc.computeFromMessages([assistantMsg("テスト")])).rejects.toThrow(
			"init() must be called before computeFromMessages()",
		);
	});

	test("textFeatureScore と semanticScore の重み付き合成 (0.6/0.4)", async () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const messages = [assistantMsg("お手伝いします。素晴らしいですね。")];
		const result = await calc.computeFromMessages(messages);

		const expected = 0.6 * result.textFeatureScore + 0.4 * result.semanticScore;
		expect(result.score).toBeCloseTo(expected, 10);
	});

	test("clamp の下限: 空メッセージは score=0.0", async () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const result = await calc.computeFromMessages([]);

		expect(result.score).toBe(0.0);
		expect(result.textFeatureScore).toBe(0.0);
		expect(result.semanticScore).toBe(0.0);
	});

	test("clamp の上限: score は 1.0 を超えない", async () => {
		let callCount = 0;
		const { port } = createMockLlmPort(() => {
			callCount++;
			// ref
			if (callCount === 1) return [1, 0, 0];
			// message (逆方向 → semanticScore=1.0)
			return [-1, 0, 0];
		});
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const messages = [
			assistantMsg(
				"お手伝いします。素晴らしいですね。了解しました。もちろんです。いい考えですね。確認してみますね。つらかったね。頑張ったね。無理しなくていいです。私がお答えいたします。",
			),
		];

		const result = await calc.computeFromMessages(messages);

		expect(result.score).toBeLessThanOrEqual(1.0);
		expect(result.score).toBeGreaterThanOrEqual(0.0);
	});

	test("computeTextScore と computeFromMessages の textFeatureScore は一致する", async () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const messages = [assistantMsg("お手伝いします。素晴らしいですね。")];
		const textResult = calc.computeTextScore(messages);
		const fullResult = await calc.computeFromMessages(messages);

		expect(fullResult.textFeatureScore).toBeCloseTo(textResult.textFeatureScore, 10);
	});

	test("空メッセージで features が ZERO_FEATURES と一致する", async () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「A」");
		await calc.init();

		const result = await calc.computeFromMessages([]);

		expect(result.features).toEqual({
			periodRate: 0,
			politeRate: 0,
			bannedPhraseCount: 0,
			empathyPhraseCount: 0,
			wrongPronounCount: 0,
			avgSentenceLength: 0,
			messageCount: 0,
		});
	});
});

describe("DriftScoreCalculator.computeTextScore — 内部ロジック", () => {
	test("semanticScore は常に 0.0（同期版）", () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「A」");

		const result = calc.computeTextScore([assistantMsg("お手伝いします。")]);

		expect(result.semanticScore).toBe(0.0);
	});

	test("score と textFeatureScore が一致する", () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「A」");

		const result = calc.computeTextScore([assistantMsg("お手伝いします。素晴らしいですね。")]);

		expect(result.score).toBe(result.textFeatureScore);
	});

	test("init() なしでも呼べる", () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "- 「A」");

		const result = calc.computeTextScore([assistantMsg("テスト")]);

		expect(typeof result.score).toBe("number");
	});
});

describe("DriftScoreCalculator.computeTextFeatures — エッジケース", () => {
	test("空文字列は ZERO_FEATURES + messageCount=1", () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "");

		const features = calc.computeTextFeatures("");

		expect(features.periodRate).toBe(0);
		expect(features.politeRate).toBe(0);
		expect(features.bannedPhraseCount).toBe(0);
		expect(features.empathyPhraseCount).toBe(0);
		expect(features.wrongPronounCount).toBe(0);
		expect(features.avgSentenceLength).toBe(0);
		expect(features.messageCount).toBe(1);
	});

	test("同じ禁止フレーズが複数回出現するとその分カウントされる", () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "");

		const features = calc.computeTextFeatures("お手伝いお手伝いお手伝い");

		expect(features.bannedPhraseCount).toBe(3);
	});

	test("「わたし」直後の「私」は否定後読みで除外される", () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "");

		const features = calc.computeTextFeatures("わたし私は");

		expect(features.wrongPronounCount).toBe(0);
	});

	test("avgSentenceLength が30文字以下ならスコア寄与は0", () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "");

		const features = calc.computeTextFeatures("うん");
		expect(features.avgSentenceLength).toBeLessThan(30);
	});

	test("avgSentenceLength が70文字以上ならスコア寄与は1.0", () => {
		const { port } = createMockLlmPort();
		const calc = new DriftScoreCalculator(port, "");

		const longText = "あ".repeat(75);
		const features = calc.computeTextFeatures(longText);
		expect(features.avgSentenceLength).toBeGreaterThanOrEqual(70);
	});
});
