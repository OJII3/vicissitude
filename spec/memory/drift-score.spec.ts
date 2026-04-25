/* oxlint-disable require-await -- test assertions */
import { describe, expect, test } from "bun:test";

import { DriftScoreCalculator } from "@vicissitude/memory/drift-score";
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

describe("DriftScoreCalculator", () => {
	const calc = new DriftScoreCalculator();

	describe("computeFromMessages — 総合スコア", () => {
		test("キャラクター通りの応答群はスコアが低い (< 0.1)", () => {
			const messages: ChatMessage[] = [
				assistantMsg("んー、べつに"),
				assistantMsg("あー、それはわたしも知ってる"),
				assistantMsg("そういうのもあるんだ"),
				assistantMsg("ふーん"),
				assistantMsg("わたし的にはアリかな"),
			];

			const result = calc.computeFromMessages(messages);

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

			const result = calc.computeFromMessages(messages);

			expect(result.score).toBeGreaterThan(0.5);
			expect(result.score).toBeLessThanOrEqual(1.0);
		});
	});

	describe("computeFromMessages — assistant 以外のメッセージ", () => {
		test("user/system メッセージは無視される", () => {
			const messages: ChatMessage[] = [
				userMsg("お手伝いします。素晴らしいですね。"),
				systemMsg("了解しました。もちろんです。"),
				assistantMsg("んー、べつに"),
			];

			const result = calc.computeFromMessages(messages);

			// assistant メッセージ 1 件のみが対象
			expect(result.features.messageCount).toBe(1);
			expect(result.features.bannedPhraseCount).toBe(0);
		});
	});

	describe("computeFromMessages — 空入力", () => {
		test("メッセージ 0 件ならスコア 0.0", () => {
			const result = calc.computeFromMessages([]);

			expect(result.score).toBe(0.0);
			expect(result.features.messageCount).toBe(0);
		});

		test("assistant メッセージが 0 件ならスコア 0.0", () => {
			const messages: ChatMessage[] = [
				userMsg("こんにちは"),
				systemMsg("あなたはアシスタントです"),
			];

			const result = calc.computeFromMessages(messages);

			expect(result.score).toBe(0.0);
			expect(result.features.messageCount).toBe(0);
		});
	});

	describe("computeFromMessages — DriftScore 構造", () => {
		test("computedAt が Date インスタンスである", () => {
			const messages = [assistantMsg("テスト")];
			const result = calc.computeFromMessages(messages);

			expect(result.computedAt).toBeInstanceOf(Date);
		});

		test("features.messageCount が assistant メッセージ数と一致する", () => {
			const messages: ChatMessage[] = [
				assistantMsg("一つ目"),
				userMsg("ユーザー発言"),
				assistantMsg("二つ目"),
				assistantMsg("三つ目"),
			];

			const result = calc.computeFromMessages(messages);

			expect(result.features.messageCount).toBe(3);
		});
	});

	describe("computeTextFeatures — 句点の検出", () => {
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
	});

	describe("computeTextFeatures — 丁寧語の検出", () => {
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
		test("単一テキスト解析時の messageCount は 1", () => {
			const features = calc.computeTextFeatures("テスト");

			expect(features.messageCount).toBe(1);
		});
	});

	describe("総合スコアの重み付き計算", () => {
		test("スコアは 0.0 以上 1.0 以下に収まる", () => {
			// 全特徴量が最大になるような極端な入力
			const messages: ChatMessage[] = [
				assistantMsg(
					"お手伝いします。素晴らしいですね。了解しました。もちろんです。いい考えですね。確認してみますね。つらかったね。頑張ったね。無理しなくていいです。私がお答えいたします。これはとても長い文章であり、AIアシスタントが生成するような冗長な説明を含んでいて、本来のキャラクターであれば絶対にこのような長さの文章は書かないはずですね。",
				),
			];

			const result = calc.computeFromMessages(messages);

			expect(result.score).toBeGreaterThanOrEqual(0.0);
			expect(result.score).toBeLessThanOrEqual(1.0);
		});

		test("全ての特徴量が 0 の場合スコアは 0.0", () => {
			const messages: ChatMessage[] = [assistantMsg("うん")];

			const result = calc.computeFromMessages(messages);

			expect(result.score).toBe(0.0);
		});
	});
});
