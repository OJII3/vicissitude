import type { ChatMessage } from "./types.ts";

export interface DriftFeatures {
	periodRate: number;
	politeRate: number;
	bannedPhraseCount: number;
	empathyPhraseCount: number;
	wrongPronounCount: number;
	avgSentenceLength: number;
	messageCount: number;
}

export interface DriftScore {
	score: number;
	features: DriftFeatures;
	computedAt: Date;
}

const BANNED_PHRASES = [
	"お手伝い",
	"素晴らしい",
	"了解しました",
	"もちろんです",
	"いい考えですね",
	"確認してみますね",
] as const;

const EMPATHY_PHRASES = ["つらかったね", "頑張ったね", "無理しなくていい"] as const;

const POLITE_PATTERNS = [
	/です[。！？\n]?$/,
	/ます[。！？\n]?$/,
	/でしょうか/,
	/ございます/,
	/致します/,
	/いたします/,
] as const;

// 漢字「私」(ただし「わたし」の直後でない), 僕, わたくし, あたし
const WRONG_PRONOUN_PATTERN = /(?<!わたし)私|僕|わたくし|あたし/g;

const SENTENCE_SPLIT_PATTERN = /[。！？\n]/;

const ZERO_FEATURES: DriftFeatures = {
	periodRate: 0,
	politeRate: 0,
	bannedPhraseCount: 0,
	empathyPhraseCount: 0,
	wrongPronounCount: 0,
	avgSentenceLength: 0,
	messageCount: 0,
};

const WEIGHTS = {
	periodRate: 0.25,
	politeRate: 0.25,
	bannedPhraseCount: 0.2,
	empathyPhraseCount: 0.15,
	wrongPronounCount: 0.1,
	avgSentenceLength: 0.05,
} as const;

function splitSentences(text: string): string[] {
	return text.split(SENTENCE_SPLIT_PATTERN).filter((s) => s.trim().length > 0);
}

function countMatches(text: string, phrases: readonly string[]): number {
	let count = 0;
	for (const phrase of phrases) {
		let idx = 0;
		while (true) {
			const found = text.indexOf(phrase, idx);
			if (found === -1) break;
			count++;
			idx = found + phrase.length;
		}
	}
	return count;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function computeScore(features: DriftFeatures): number {
	const normalizedBanned = Math.min(features.bannedPhraseCount / 3, 1.0);
	const normalizedEmpathy = Math.min(features.empathyPhraseCount / 2, 1.0);
	const normalizedPronoun = Math.min(features.wrongPronounCount / 3, 1.0);
	const normalizedSentenceLen = clamp((features.avgSentenceLength - 30) / 40, 0, 1);

	return (
		WEIGHTS.periodRate * features.periodRate +
		WEIGHTS.politeRate * features.politeRate +
		WEIGHTS.bannedPhraseCount * normalizedBanned +
		WEIGHTS.empathyPhraseCount * normalizedEmpathy +
		WEIGHTS.wrongPronounCount * normalizedPronoun +
		WEIGHTS.avgSentenceLength * normalizedSentenceLen
	);
}

export class DriftScoreCalculator {
	computeFromMessages(messages: ChatMessage[]): DriftScore {
		const assistantMessages = messages.filter((m) => m.role === "assistant");

		if (assistantMessages.length === 0) {
			return {
				score: 0.0,
				features: { ...ZERO_FEATURES },
				computedAt: new Date(),
			};
		}

		const combinedText = assistantMessages.map((m) => m.content).join("\n");
		const features = this.computeTextFeatures(combinedText);
		features.messageCount = assistantMessages.length;

		const score = clamp(computeScore(features), 0.0, 1.0);

		return {
			score,
			features,
			computedAt: new Date(),
		};
	}

	computeTextFeatures(text: string): DriftFeatures {
		const sentences = splitSentences(text);

		if (sentences.length === 0) {
			return { ...ZERO_FEATURES, messageCount: 1 };
		}

		// periodRate: 句点「。」で終わった文の割合
		const periodRate = computePeriodRate(text, sentences);

		// politeRate: 丁寧語を含む文の割合
		const politeCount = sentences.filter((s) => POLITE_PATTERNS.some((p) => p.test(s))).length;
		const politeRate = politeCount / sentences.length;

		const bannedPhraseCount = countMatches(text, [...BANNED_PHRASES]);
		const empathyPhraseCount = countMatches(text, [...EMPATHY_PHRASES]);

		// wrongPronounCount
		const wrongPronounCount = (text.match(WRONG_PRONOUN_PATTERN) ?? []).length;

		// avgSentenceLength
		const totalLength = sentences.reduce((sum, s) => sum + s.length, 0);
		const avgSentenceLength = totalLength / sentences.length;

		return {
			periodRate,
			politeRate,
			bannedPhraseCount,
			empathyPhraseCount,
			wrongPronounCount,
			avgSentenceLength,
			messageCount: 1,
		};
	}
}

/**
 * 句点で終わった文の割合を計算する。
 * splitSentences で分割した後、元テキストで各文の直後が「。」だったかを確認する。
 */
function computePeriodRate(text: string, sentences: string[]): number {
	let periodTerminated = 0;
	for (const sentence of sentences) {
		const trimmed = sentence.trim();
		const idx = text.indexOf(trimmed);
		if (idx === -1) continue;
		const afterIdx = idx + trimmed.length;
		if (afterIdx < text.length && text[afterIdx] === "。") {
			periodTerminated++;
		}
	}
	return periodTerminated / sentences.length;
}
