import type { DriftScore, DriftScoreCalculator } from "./drift-score.ts";
import type { MemoryLlmPort, Schema } from "./llm-port.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import { createFact } from "./semantic-fact.ts";
import type { MemoryStorage } from "./storage.ts";
import type { ChatMessage } from "./types.ts";
import { escapeXmlContent } from "./utils.ts";

// ─── Public types ───────────────────────────────────────────────

export type CriticSeverity = "none" | "minor" | "major";

export interface CriticResult {
	severity: CriticSeverity;
	summary: string;
	driftScore?: number;
	guidelineFact?: string;
	guidelineKeywords?: string[];
	issueTitle?: string;
	issueBody?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const NINETY_MINUTES_MS = 90 * 60_000;
const RECENT_EPISODE_LIMIT = 20;
const DRIFT_SKIP_THRESHOLD = 0.03;
const MIN_EPISODES_FOR_CHEAP_SKIP = 3;

const VALID_SEVERITIES = new Set<string>(["none", "minor", "major"]);

// ─── CriticAuditor ──────────────────────────────────────────────

export interface CriticAuditorDeps {
	llm: MemoryLlmPort;
	storage: MemoryStorage;
	driftCalculator: DriftScoreCalculator;
	characterDefinition: string;
	/** Discord user id of this bot. Used to filter assistant messages by stable identifier. */
	botUserId: string;
	nowProvider?: () => number;
}

export class CriticAuditor {
	private readonly llm: MemoryLlmPort;
	private readonly storage: MemoryStorage;
	private readonly driftCalculator: DriftScoreCalculator;
	readonly characterDefinition: string;
	private readonly botUserId: string;
	private readonly nowProvider: () => number;

	constructor(deps: CriticAuditorDeps) {
		this.llm = deps.llm;
		this.storage = deps.storage;
		this.driftCalculator = deps.driftCalculator;
		this.characterDefinition = deps.characterDefinition;
		this.botUserId = deps.botUserId;
		this.nowProvider = deps.nowProvider ?? Date.now;
	}

	/** 直近の応答を監査し、キャラクター一貫性を評価する */
	async audit(userId: string): Promise<CriticResult | null> {
		const sinceMs = this.nowProvider() - NINETY_MINUTES_MS;
		const episodes = await this.storage.getRecentEpisodes(userId, sinceMs, RECENT_EPISODE_LIMIT);

		// bot の assistant メッセージのみ抽出（authorId が一致しないメッセージはスキップ）
		// guild ニックネームと無関係な、stable な platform user id でフィルタすることで
		// ニックネーム衝突や同名の他 bot による誤検知を防ぐ（#847）
		const assistantMessages: ChatMessage[] = episodes.flatMap((ep) =>
			ep.messages.filter((m) => m.role === "assistant" && m.authorId === this.botUserId),
		);
		if (assistantMessages.length === 0) return null;

		// ドリフトスコア計算
		const driftScore = await this.driftCalculator.computeFromMessages(assistantMessages);

		// コスト最適化: スコアが低くエピソード数も少ない場合はスキップ
		if (driftScore.score < DRIFT_SKIP_THRESHOLD && episodes.length < MIN_EPISODES_FOR_CHEAP_SKIP) {
			return null;
		}

		// 既存ガイドラインを取得
		const guidelines = await this.storage.getFactsByCategory(userId, "guideline");

		// LLM に監査を依頼
		const result = await this.llm.chatStructured<CriticResult>(
			buildCriticMessages(this.characterDefinition, driftScore, guidelines, assistantMessages),
			criticResultSchema,
		);

		// minor の場合、guideline fact を保存
		if (result.severity === "minor" && result.guidelineFact) {
			const embedding = await this.llm.embed(result.guidelineFact);
			const fact = createFact({
				userId,
				category: "guideline",
				fact: result.guidelineFact,
				keywords: result.guidelineKeywords ?? [],
				sourceEpisodicIds: [],
				embedding,
			});
			await this.storage.saveFact(userId, fact);
		}

		return { ...result, driftScore: driftScore.score };
	}
}

// ─── Prompt construction ────────────────────────────────────────

function buildCriticMessages(
	characterDefinition: string,
	driftScore: DriftScore,
	guidelines: SemanticFact[],
	assistantMessages: ChatMessage[],
): ChatMessage[] {
	const guidelineSection =
		guidelines.length > 0
			? guidelines.map((g) => `- ${escapeXmlContent(g.fact)}`).join("\n")
			: "(なし)";

	const featuresText = Object.entries(driftScore.features)
		.map(([k, v]) => `  ${k}: ${String(v)}`)
		.join("\n");

	const system = `あなたはキャラクター一貫性の監査者です。AIキャラクターの応答が定義されたペルソナに忠実であるかを評価します。

<character_definition>
${escapeXmlContent(characterDefinition)}
</character_definition>

<drift_analysis>
score: ${String(driftScore.score.toFixed(4))}
textFeatureScore: ${String(driftScore.textFeatureScore.toFixed(4))}
semanticScore: ${String(driftScore.semanticScore.toFixed(4))}
features:
${featuresText}
</drift_analysis>

<existing_guidelines>
${guidelineSection}
</existing_guidelines>

## 評価基準
- チャッピー口調（丁寧すぎる、AIアシスタント的な表現）の検出
- 感情の平坦化（常に同じトーンで応答する）の検出
- 問題解決モード侵入（ユーザーの話を聞く代わりに解決策を提示する）の検出
- キャラクター定義からの逸脱全般

## 出力形式
JSON で以下のフィールドを含めてください:
- severity: "none" | "minor" | "major"
- summary: 評価結果の要約（日本語）
- guidelineFact: severity が "minor" の場合、保存すべきガイドライン（日本語、省略可）
- guidelineKeywords: ガイドラインのキーワード配列（省略可）
- issueTitle: severity が "major" の場合の Issue タイトル（省略可）
- issueBody: severity が "major" の場合の Issue 本文（省略可）

日本語で回答してください。`;

	const userContent = assistantMessages.map((m) => escapeXmlContent(m.content)).join("\n---\n");

	return [
		{ role: "system", content: system },
		{ role: "user", content: userContent },
	];
}

// ─── Schema validation ──────────────────────────────────────────

const criticResultSchema: Schema<CriticResult> = {
	parse(data: unknown): CriticResult {
		if (typeof data !== "object" || data === null) {
			throw new TypeError("Expected object");
		}
		const obj = data as Record<string, unknown>;

		if (typeof obj["severity"] !== "string" || !VALID_SEVERITIES.has(obj["severity"])) {
			throw new TypeError(`severity: expected one of none, minor, major`);
		}
		if (typeof obj["summary"] !== "string" || obj["summary"] === "") {
			throw new TypeError("summary: expected non-empty string");
		}

		return {
			severity: obj["severity"] as CriticSeverity,
			summary: obj["summary"],
			guidelineFact: typeof obj["guidelineFact"] === "string" ? obj["guidelineFact"] : undefined,
			guidelineKeywords: Array.isArray(obj["guidelineKeywords"])
				? (obj["guidelineKeywords"] as string[])
				: undefined,
			issueTitle: typeof obj["issueTitle"] === "string" ? obj["issueTitle"] : undefined,
			issueBody: typeof obj["issueBody"] === "string" ? obj["issueBody"] : undefined,
		};
	},
};
