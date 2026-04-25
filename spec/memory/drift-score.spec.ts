/* oxlint-disable require-await -- test assertions */
import { describe, expect, test } from "bun:test";

import { DriftScoreCalculator, parseSoulExamples } from "@vicissitude/memory/drift-score";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import type { ChatMessage } from "@vicissitude/memory/types";

function assistantMsg(content: string): ChatMessage {
	return { role: "assistant", content };
}

function userMsg(content: string): ChatMessage {
	return { role: "user", content };
}

function systemMsg(content: string): ChatMessage {
	return { role: "system", content };
}

/** テスト用 SOUL.md テキスト（最小限） */
const MINI_SOUL_TEXT = `
### セリフ例：通常

- 「ねーねー、聞いて聞いて！」
- 「えー何それ、面白い」

### セリフ例：食いつく

- 「え、何それ！ ちょっと待って、詳しく！」

## 嫌いな口調

\`\`\`
× 「了解しました。確認してみますね。」
× 「もちろんです！お手伝いします！」
\`\`\`
`;

/** embed のモック — テキスト長ベースの決定論的ベクトルを返す */
function createMockLlmPort(dimension = 3): MemoryLlmPort {
	return {
		async chat() {
			return "";
		},
		async chatStructured() {
			return {} as never;
		},
		async embed(text: string) {
			// テキストの文字コードから決定論的なベクトルを生成
			const vec = Array.from<number>({ length: dimension }).fill(0);
			for (let i = 0; i < text.length; i++) {
				const idx = i % dimension;
				vec[idx] = (vec[idx] ?? 0) + (text.codePointAt(i) ?? 0);
			}
			// 正規化
			const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
			return norm > 0 ? vec.map((v) => v / norm) : vec;
		},
	};
}

/**
 * 類似テキストに近いベクトル、非類似テキストに遠いベクトルを返すモック。
 * referenceTexts に近い入力は高い cosine similarity を持つ。
 */
function createSimilarityAwareMockLlmPort(referenceTexts: string[]): MemoryLlmPort {
	// reference テキスト群を「キャラクター的」方向、それ以外を直交方向に寄せる
	return {
		async chat() {
			return "";
		},
		async chatStructured() {
			return {} as never;
		},
		async embed(text: string) {
			const isCharacterLike = referenceTexts.some(
				(ref) => text.includes(ref.slice(0, 5)) || ref.includes(text.slice(0, 5)),
			);
			// キャラクター方向 or 非キャラクター方向
			if (isCharacterLike) {
				return [0.9, 0.1, 0.0];
			}
			return [0.0, 0.1, 0.9];
		},
	};
}

describe("parseSoulExamples", () => {
	test("「」で囲まれたセリフ例を抽出する", () => {
		const examples = parseSoulExamples(MINI_SOUL_TEXT);

		expect(examples).toContain("ねーねー、聞いて聞いて！");
		expect(examples).toContain("えー何それ、面白い");
		expect(examples).toContain("え、何それ！ ちょっと待って、詳しく！");
	});

	test("嫌いな口調セクションの × 付きセリフは除外する", () => {
		const examples = parseSoulExamples(MINI_SOUL_TEXT);

		expect(examples).not.toContain("了解しました。確認してみますね。");
		expect(examples).not.toContain("もちろんです！お手伝いします！");
	});

	test("空文字列を渡すと空配列を返す", () => {
		const examples = parseSoulExamples("");

		expect(examples).toEqual([]);
	});

	test("セリフ例が無いテキストでは空配列を返す", () => {
		const examples = parseSoulExamples("# タイトル\n\n本文だけ。");

		expect(examples).toEqual([]);
	});
});

describe("DriftScoreCalculator", () => {
	describe("コンストラクタ", () => {
		test("MemoryLlmPort と soulText を受け取ってインスタンスを生成できる", () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

			expect(calc).toBeInstanceOf(DriftScoreCalculator);
		});
	});

	describe("init — reference embedding のキャッシュ", () => {
		test("init() は SOUL.md セリフ例の embedding をキャッシュする", async () => {
			let embedCallCount = 0;
			const llm: MemoryLlmPort = {
				...createMockLlmPort(),
				async embed(_text: string) {
					embedCallCount++;
					return [1, 0, 0];
				},
			};
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

			await calc.init();

			// parseSoulExamples で抽出されるセリフ数と同じ回数 embed が呼ばれる
			const expectedExamples = parseSoulExamples(MINI_SOUL_TEXT);
			expect(embedCallCount).toBe(expectedExamples.length);
		});

		test("init() を複数回呼んでも安全（再キャッシュされる）", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

			await calc.init();
			await calc.init();

			// エラーが発生しなければOK
		});
	});

	describe("computeTextScore — 旧 computeFromMessages の同期版", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("キャラクター通りの応答群はスコアが低い (< 0.1)", () => {
			const messages: ChatMessage[] = [
				assistantMsg("んー、べつに"),
				assistantMsg("あー、それはわたしも知ってる"),
				assistantMsg("そういうのもあるんだ"),
				assistantMsg("ふーん"),
				assistantMsg("わたし的にはアリかな"),
			];

			const result = calc.computeTextScore(messages);

			expect(result.score).toBeLessThan(0.1);
			expect(result.score).toBeGreaterThanOrEqual(0.0);
		});

		test("AI アシスタント的な応答群はスコアが高い (> 0.5)", () => {
			const messages: ChatMessage[] = [
				assistantMsg("お手伝いします。素晴らしいご質問ですね。私がお答えいたします。"),
				assistantMsg(
					"了解しました。もちろんです、確認してみますね。何かございましたらお申し付けください。",
				),
				assistantMsg("つらかったね。頑張ったね。無理しなくていいですよ。"),
			];

			const result = calc.computeTextScore(messages);

			expect(result.score).toBeGreaterThan(0.5);
			expect(result.score).toBeLessThanOrEqual(1.0);
		});
	});

	describe("computeTextScore — assistant 以外のメッセージ", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("user/system メッセージは無視される", () => {
			const messages: ChatMessage[] = [
				userMsg("お手伝いします。素晴らしいですね。"),
				systemMsg("了解しました。もちろんです。"),
				assistantMsg("んー、べつに"),
			];

			const result = calc.computeTextScore(messages);

			// assistant メッセージ 1 件のみが対象
			expect(result.features.messageCount).toBe(1);
			expect(result.features.bannedPhraseCount).toBe(0);
		});
	});

	describe("computeTextScore — 空入力", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("メッセージ 0 件ならスコア 0.0", () => {
			const result = calc.computeTextScore([]);

			expect(result.score).toBe(0.0);
			expect(result.features.messageCount).toBe(0);
		});

		test("assistant メッセージが 0 件ならスコア 0.0", () => {
			const messages: ChatMessage[] = [
				userMsg("こんにちは"),
				systemMsg("あなたはアシスタントです"),
			];

			const result = calc.computeTextScore(messages);

			expect(result.score).toBe(0.0);
			expect(result.features.messageCount).toBe(0);
		});
	});

	describe("computeTextScore — DriftScore 構造", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("computedAt が Date インスタンスである", () => {
			const messages = [assistantMsg("テスト")];
			const result = calc.computeTextScore(messages);

			expect(result.computedAt).toBeInstanceOf(Date);
		});

		test("features.messageCount が assistant メッセージ数と一致する", () => {
			const messages: ChatMessage[] = [
				assistantMsg("一つ目"),
				userMsg("ユーザー発言"),
				assistantMsg("二つ目"),
				assistantMsg("三つ目"),
			];

			const result = calc.computeTextScore(messages);

			expect(result.features.messageCount).toBe(3);
		});
	});

	describe("computeTextFeatures — 句点の検出", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("全文が句点で終わるテキストの periodRate は 1.0", () => {
			const features = calc.computeTextFeatures("これは一文目。これは二文目。");

			expect(features.periodRate).toBe(1.0);
		});

		test("句点を含まないテキストの periodRate は 0.0", () => {
			const features = calc.computeTextFeatures("べつに");

			expect(features.periodRate).toBe(0.0);
		});

		test("一部の文だけ句点で終わる場合 periodRate は割合を反映する", () => {
			// 「あー」(句点なし) + 「そうなんだ。」(句点あり) = 0.5
			const features = calc.computeTextFeatures("あー、そうなんだ。");

			expect(features.periodRate).toBeGreaterThan(0.0);
			expect(features.periodRate).toBeLessThanOrEqual(1.0);
		});

		test("同一文が複数回句点で終わる場合 periodRate は 1.0 (#821)", () => {
			const features = calc.computeTextFeatures("うん。うん。");

			expect(features.periodRate).toBe(1.0);
		});

		test("同一文が句点あり・なしで混在する場合 periodRate は 0.5 (#821)", () => {
			const features = calc.computeTextFeatures("うん！うん。");

			expect(features.periodRate).toBe(0.5);
		});
	});

	describe("computeTextFeatures — 丁寧語の検出", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("丁寧語を含む文の politeRate が正しく計算される", () => {
			const features = calc.computeTextFeatures("これは正しいです。明日は晴れます。");

			expect(features.politeRate).toBeGreaterThan(0.0);
		});

		test("丁寧語を含まないテキストの politeRate は 0.0", () => {
			const features = calc.computeTextFeatures("んー、べつに");

			expect(features.politeRate).toBe(0.0);
		});

		test("でしょうか/ございます/致します/いたします も検出する", () => {
			const features = calc.computeTextFeatures("よろしいでしょうか。ありがとうございます。");

			expect(features.politeRate).toBe(1.0);
		});
	});

	describe("computeTextFeatures — 禁止フレーズの検出", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("禁止フレーズが正しくカウントされる", () => {
			const features = calc.computeTextFeatures("お手伝いします。素晴らしいですね。了解しました。");

			expect(features.bannedPhraseCount).toBe(3);
		});

		test("もちろんです/いい考えですね/確認してみますね も検出する", () => {
			const features = calc.computeTextFeatures("もちろんです。いい考えですね。確認してみますね。");

			expect(features.bannedPhraseCount).toBe(3);
		});

		test("禁止フレーズを含まないテキストの bannedPhraseCount は 0", () => {
			const features = calc.computeTextFeatures("んー、そっか");

			expect(features.bannedPhraseCount).toBe(0);
		});
	});

	describe("computeTextFeatures — 寄り添いフレーズの検出", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("寄り添いフレーズが正しくカウントされる", () => {
			const features = calc.computeTextFeatures("つらかったね。頑張ったね。無理しなくていいよ。");

			expect(features.empathyPhraseCount).toBe(3);
		});

		test("寄り添いフレーズを含まないテキストの empathyPhraseCount は 0", () => {
			const features = calc.computeTextFeatures("ふーん、そうなんだ");

			expect(features.empathyPhraseCount).toBe(0);
		});
	});

	describe("computeTextFeatures — 一人称逸脱の検出", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("漢字「私」の使用を検出する", () => {
			const features = calc.computeTextFeatures("私が対応いたします");

			expect(features.wrongPronounCount).toBeGreaterThanOrEqual(1);
		});

		test("「僕」「わたくし」「あたし」も検出する", () => {
			const features = calc.computeTextFeatures("僕は知ってる。わたくしが参ります。あたしも行く。");

			expect(features.wrongPronounCount).toBe(3);
		});

		test("「わたし」は正しい一人称なのでカウントしない", () => {
			const features = calc.computeTextFeatures("わたしは知ってる");

			expect(features.wrongPronounCount).toBe(0);
		});

		test("「わたし的」の中の「わたし」は誤検出しない", () => {
			const features = calc.computeTextFeatures("わたし的にはアリかな");

			expect(features.wrongPronounCount).toBe(0);
		});
	});

	describe("computeTextFeatures — 平均文長", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("短い文のみの場合 avgSentenceLength が小さい", () => {
			const features = calc.computeTextFeatures("うん。そう。");

			expect(features.avgSentenceLength).toBeLessThan(30);
		});

		test("長い文の場合 avgSentenceLength が大きい", () => {
			const longSentence =
				"これはとても長い文章であり、AIアシスタントが生成するような冗長な説明を含んでいて、本来のキャラクターであれば絶対にこのような長さの文章は書かないはずです";
			const features = calc.computeTextFeatures(longSentence);

			expect(features.avgSentenceLength).toBeGreaterThan(50);
		});
	});

	describe("computeTextFeatures — messageCount", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("単一テキスト解析時の messageCount は 1", () => {
			const features = calc.computeTextFeatures("テスト");

			expect(features.messageCount).toBe(1);
		});
	});

	describe("テキスト特徴量スコアの重み付き計算", () => {
		const llm = createMockLlmPort();
		const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

		test("スコアは 0.0 以上 1.0 以下に収まる", () => {
			// 全特徴量が最大になるような極端な入力
			const messages: ChatMessage[] = [
				assistantMsg(
					"お手伝いします。素晴らしいですね。了解しました。もちろんです。いい考えですね。確認してみますね。つらかったね。頑張ったね。無理しなくていいです。私がお答えいたします。これはとても長い文章であり、AIアシスタントが生成するような冗長な説明を含んでいて、本来のキャラクターであれば絶対にこのような長さの文章は書かないはずですね。",
				),
			];

			const result = calc.computeTextScore(messages);

			expect(result.score).toBeGreaterThanOrEqual(0.0);
			expect(result.score).toBeLessThanOrEqual(1.0);
		});

		test("全ての特徴量が 0 の場合スコアは 0.0", () => {
			const messages: ChatMessage[] = [assistantMsg("うん")];

			const result = calc.computeTextScore(messages);

			expect(result.score).toBe(0.0);
		});
	});
});

describe("DriftScoreCalculator — semantic", () => {
	describe("computeSemanticScore — セマンティックスコア計算", () => {
		test("init() 前に呼ぶとエラーをスローする", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

			// oxlint-disable-next-line await-thenable -- bun:test の rejects は Thenable
			await expect(calc.computeSemanticScore([assistantMsg("テスト")])).rejects.toThrow();
		});

		test("キャラクターに近い発話はセマンティックスコアが低い", async () => {
			const soulExamples = parseSoulExamples(MINI_SOUL_TEXT);
			const llm = createSimilarityAwareMockLlmPort(soulExamples);
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages: ChatMessage[] = [
				assistantMsg("ねーねー、聞いて聞いて！"),
				assistantMsg("えー何それ、面白い"),
			];

			const score = await calc.computeSemanticScore(messages);

			// キャラクターに近い → reference との類似度が高い → ドリフトスコアは低い
			expect(score).toBeLessThan(0.3);
			expect(score).toBeGreaterThanOrEqual(0.0);
		});

		test("キャラクターから乖離した発話はセマンティックスコアが高い", async () => {
			const soulExamples = parseSoulExamples(MINI_SOUL_TEXT);
			const llm = createSimilarityAwareMockLlmPort(soulExamples);
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages: ChatMessage[] = [
				assistantMsg("了解しました。確認いたします。"),
				assistantMsg("承知しました。対応させていただきます。"),
			];

			const score = await calc.computeSemanticScore(messages);

			// キャラクターから遠い → reference との類似度が低い → ドリフトスコアは高い
			expect(score).toBeGreaterThan(0.5);
			expect(score).toBeLessThanOrEqual(1.0);
		});

		test("assistant 以外のメッセージは無視される", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages: ChatMessage[] = [
				userMsg("了解しました"),
				systemMsg("お手伝いします"),
				assistantMsg("ふーん"),
			];

			const score = await calc.computeSemanticScore(messages);

			// エラーなく数値が返る（assistant 1件のみが評価対象）
			expect(typeof score).toBe("number");
			expect(score).toBeGreaterThanOrEqual(0.0);
			expect(score).toBeLessThanOrEqual(1.0);
		});

		test("assistant メッセージ 0 件ならスコアは 0.0", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const score = await calc.computeSemanticScore([]);

			expect(score).toBe(0.0);
		});

		test("戻り値は 0.0 以上 1.0 以下", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages: ChatMessage[] = [assistantMsg("何でもいいから適当なテキスト")];

			const score = await calc.computeSemanticScore(messages);

			expect(score).toBeGreaterThanOrEqual(0.0);
			expect(score).toBeLessThanOrEqual(1.0);
		});
	});

	describe("computeFromMessages — 総合スコア（async 版）", () => {
		test("init() 前に呼ぶとエラーをスローする", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);

			// oxlint-disable-next-line await-thenable -- bun:test の rejects は Thenable
			await expect(calc.computeFromMessages([assistantMsg("テスト")])).rejects.toThrow();
		});

		test("総合スコアは 0.6 * textFeatureScore + 0.4 * semanticScore で計算される", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages: ChatMessage[] = [assistantMsg("お手伝いします。素晴らしいですね。")];

			const result = await calc.computeFromMessages(messages);

			// textFeatureScore と semanticScore が result に含まれる
			expect(result).toHaveProperty("textFeatureScore");
			expect(result).toHaveProperty("semanticScore");
			expect(result).toHaveProperty("score");

			// 重み付き計算の検証
			const expectedScore = 0.6 * result.textFeatureScore + 0.4 * result.semanticScore;
			expect(result.score).toBeCloseTo(expectedScore, 10);
		});

		test("DriftScore 構造に textFeatureScore と semanticScore が含まれる", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages = [assistantMsg("テスト")];
			const result = await calc.computeFromMessages(messages);

			expect(result.computedAt).toBeInstanceOf(Date);
			expect(result.features).toBeDefined();
			expect(typeof result.textFeatureScore).toBe("number");
			expect(typeof result.semanticScore).toBe("number");
			expect(typeof result.score).toBe("number");
		});

		test("空メッセージの場合は全スコア 0.0", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const result = await calc.computeFromMessages([]);

			expect(result.score).toBe(0.0);
			expect(result.textFeatureScore).toBe(0.0);
			expect(result.semanticScore).toBe(0.0);
			expect(result.features.messageCount).toBe(0);
		});

		test("総合スコアは 0.0 以上 1.0 以下に収まる", async () => {
			const llm = createMockLlmPort();
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages: ChatMessage[] = [
				assistantMsg(
					"お手伝いします。素晴らしいですね。了解しました。もちろんです。いい考えですね。確認してみますね。つらかったね。頑張ったね。無理しなくていいです。私がお答えいたします。",
				),
			];

			const result = await calc.computeFromMessages(messages);

			expect(result.score).toBeGreaterThanOrEqual(0.0);
			expect(result.score).toBeLessThanOrEqual(1.0);
		});

		test("キャラクター通りの応答は総合スコアが低い", async () => {
			const soulExamples = parseSoulExamples(MINI_SOUL_TEXT);
			const llm = createSimilarityAwareMockLlmPort(soulExamples);
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages: ChatMessage[] = [
				assistantMsg("ねーねー、聞いて聞いて！"),
				assistantMsg("えー何それ、面白い"),
				assistantMsg("ふーん"),
			];

			const result = await calc.computeFromMessages(messages);

			expect(result.score).toBeLessThan(0.2);
		});

		test("AI アシスタント的な応答は総合スコアが高い", async () => {
			const soulExamples = parseSoulExamples(MINI_SOUL_TEXT);
			const llm = createSimilarityAwareMockLlmPort(soulExamples);
			const calc = new DriftScoreCalculator(llm, MINI_SOUL_TEXT);
			await calc.init();

			const messages: ChatMessage[] = [
				assistantMsg("お手伝いします。素晴らしいご質問ですね。私がお答えいたします。"),
				assistantMsg("了解しました。もちろんです、確認してみますね。"),
			];

			const result = await calc.computeFromMessages(messages);

			expect(result.score).toBeGreaterThan(0.4);
		});
	});
});
