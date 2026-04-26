import type { MemoryLlmPort } from "./llm-port.ts";
import type { ChatMessage } from "./types.ts";
import { cosineSimilarity } from "./vector-math.ts";

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
	textFeatureScore: number;
	semanticScore: number;
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

/**
 * SOUL.md テキストからセリフ例を抽出する。× 付き（嫌いな口調）は除外。
 */
export function parseSoulExamples(soulText: string): string[] {
	if (!soulText) return [];

	const results: string[] = [];
	const lines = soulText.split("\n");

	for (const line of lines) {
		// × で始まる行のセリフは除外
		if (/^\s*[×✕]/.test(line)) continue;

		// 「...」で囲まれたセリフを抽出
		const matches = line.matchAll(/「([^」]+)」/g);
		for (const match of matches) {
			if (match[1]) {
				results.push(match[1]);
			}
		}
	}

	return results;
}

export class DriftScoreCalculator {
	private readonly llm: MemoryLlmPort;
	private readonly soulText: string;
	private referenceEmbeddings: number[][] | null = null;

	constructor(llm: MemoryLlmPort, soulText: string) {
		this.llm = llm;
		this.soulText = soulText;
	}

	/** SOUL.md セリフ例の embedding をキャッシュ。computeFromMessages/computeSemanticScore の前に呼ぶ必要あり */
	async init(): Promise<void> {
		const examples = parseSoulExamples(this.soulText);
		this.referenceEmbeddings = await Promise.all(examples.map((ex) => this.llm.embed(ex)));
	}

	/** 旧 computeFromMessages のリネーム。同期版、テキスト特徴量のみ */
	computeTextScore(messages: ChatMessage[]): DriftScore {
		const assistantMessages = messages.filter((m) => m.role === "assistant");

		if (assistantMessages.length === 0) {
			return {
				score: 0.0,
				textFeatureScore: 0.0,
				semanticScore: 0.0,
				features: { ...ZERO_FEATURES },
				computedAt: new Date(),
			};
		}

		const combinedText = assistantMessages.map((m) => m.content).join("\n");
		const features = this.computeTextFeatures(combinedText);
		features.messageCount = assistantMessages.length;

		const textFeatureScore = clamp(computeScore(features), 0.0, 1.0);

		return {
			score: textFeatureScore,
			textFeatureScore,
			semanticScore: 0.0,
			features,
			computedAt: new Date(),
		};
	}

	/** セマンティックスコアのみ計算。init() 前に呼ぶとエラー */
	async computeSemanticScore(messages: ChatMessage[]): Promise<number> {
		if (this.referenceEmbeddings === null) {
			throw new Error("init() must be called before computeSemanticScore()");
		}

		const assistantMessages = messages.filter((m) => m.role === "assistant");
		if (assistantMessages.length === 0) return 0.0;

		const refs = this.referenceEmbeddings;
		if (refs.length === 0) return 0.0;

		const embeddings = await Promise.all(
			assistantMessages.map((msg) => this.llm.embed(msg.content)),
		);
		let totalMaxSim = 0;
		for (const embedding of embeddings) {
			let maxSim = -Infinity;
			for (const ref of refs) {
				const sim = cosineSimilarity(embedding, ref);
				if (sim > maxSim) maxSim = sim;
			}
			totalMaxSim += maxSim;
		}

		const avgSimilarity = totalMaxSim / assistantMessages.length;
		return clamp(1.0 - avgSimilarity, 0.0, 1.0);
	}

	/** 総合スコア（async）。init() 前に呼ぶとエラー */
	async computeFromMessages(messages: ChatMessage[]): Promise<DriftScore> {
		if (this.referenceEmbeddings === null) {
			throw new Error("init() must be called before computeFromMessages()");
		}

		const assistantMessages = messages.filter((m) => m.role === "assistant");

		if (assistantMessages.length === 0) {
			return {
				score: 0.0,
				textFeatureScore: 0.0,
				semanticScore: 0.0,
				features: { ...ZERO_FEATURES },
				computedAt: new Date(),
			};
		}

		const combinedText = assistantMessages.map((m) => m.content).join("\n");
		const features = this.computeTextFeatures(combinedText);
		features.messageCount = assistantMessages.length;

		const textFeatureScore = clamp(computeScore(features), 0.0, 1.0);
		const semanticScore = await this.computeSemanticScore(messages);
		const score = clamp(0.6 * textFeatureScore + 0.4 * semanticScore, 0.0, 1.0);

		return {
			score,
			textFeatureScore,
			semanticScore,
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
	let searchFrom = 0;
	for (const sentence of sentences) {
		const trimmed = sentence.trim();
		const idx = text.indexOf(trimmed, searchFrom);
		if (idx === -1) continue;
		const afterIdx = idx + trimmed.length;
		if (afterIdx < text.length && text[afterIdx] === "。") {
			periodTerminated++;
		}
		searchFrom = afterIdx;
	}
	return periodTerminated / sentences.length;
}
