import { z } from "zod";

import type { DriftScore, DriftScoreCalculator } from "./drift-score.ts";
import type { MemoryLlmPort, Schema } from "./llm-port.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import { createFact } from "./semantic-fact.ts";
import type { MemoryStorage } from "./storage.ts";
import type { ChatMessage } from "./types.ts";
import { escapeXmlContent } from "./utils.ts";

// ─── Public types ───────────────────────────────────────────────

export type CriticSeverity = "none" | "minor" | "major";
export type CriticSkipReason = "no_messages" | "low_drift";

export interface CriticResult {
	severity: CriticSeverity;
	summary: string;
	driftScore?: number;
	guidelineFact?: string;
	guidelineKeywords?: string[];
	guidelineResolution?: GuidelineResolution;
	issueTitle?: string;
	issueBody?: string;
}

export type GuidelineResolutionAction = "save" | "discard" | "replace";

export interface GuidelineResolution {
	action: GuidelineResolutionAction;
	reason: string;
	targetGuidelineIds?: string[];
}

interface GuidelineApplicationInput {
	userId: string;
	guidelineFact: string;
	guidelineKeywords: string[];
	resolution: GuidelineResolution;
	existingGuidelines: SemanticFact[];
}

export interface CriticSkipped {
	status: "skipped";
	reason: CriticSkipReason;
	driftScore?: number;
}

export type CriticAuditOutcome = (CriticResult & { status: "completed" }) | CriticSkipped;

// ─── Constants ──────────────────────────────────────────────────

const NINETY_MINUTES_MS = 90 * 60_000;
const RECENT_EPISODE_LIMIT = 20;
const DRIFT_SKIP_THRESHOLD = 0.03;
const MIN_EPISODES_FOR_CHEAP_SKIP = 3;

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
	private readonly characterDefinition: string;
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
	async audit(userId: string): Promise<CriticAuditOutcome> {
		const sinceMs = this.nowProvider() - NINETY_MINUTES_MS;
		const episodes = await this.storage.getRecentEpisodes(userId, sinceMs, RECENT_EPISODE_LIMIT);

		// bot の assistant メッセージのみ抽出（authorId が一致しないメッセージはスキップ）
		// guild ニックネームと無関係な、stable な platform user id でフィルタすることで
		// ニックネーム衝突や同名の他 bot による誤検知を防ぐ（#847）
		const assistantMessages: ChatMessage[] = episodes.flatMap((ep) =>
			ep.messages.filter((m) => m.role === "assistant" && m.authorId === this.botUserId),
		);
		if (assistantMessages.length === 0) return { status: "skipped", reason: "no_messages" };

		// ドリフトスコア計算
		const driftScore = await this.driftCalculator.computeFromMessages(assistantMessages);

		// コスト最適化: スコアが低くエピソード数も少ない場合はスキップ
		if (driftScore.score < DRIFT_SKIP_THRESHOLD && episodes.length < MIN_EPISODES_FOR_CHEAP_SKIP) {
			return { status: "skipped", reason: "low_drift", driftScore: driftScore.score };
		}

		// 既存ガイドラインを取得
		const guidelines = await this.storage.getFactsByCategory(userId, "guideline");

		// LLM に監査を依頼
		const result = await this.llm.chatStructured<CriticResult>(
			buildCriticMessages(this.characterDefinition, driftScore, guidelines, assistantMessages),
			criticResultSchema,
		);

		let guidelineResolution: GuidelineResolution | undefined;

		// minor の場合、保存前に既存 guideline / character definition との関係を解決する
		if (result.severity === "minor" && result.guidelineFact) {
			guidelineResolution = await this.resolveGuideline(result.guidelineFact, guidelines);
			await this.applyGuidelineResolution({
				userId,
				guidelineFact: result.guidelineFact,
				guidelineKeywords: result.guidelineKeywords ?? [],
				resolution: guidelineResolution,
				existingGuidelines: guidelines,
			});
		}

		return { ...result, guidelineResolution, status: "completed", driftScore: driftScore.score };
	}

	private resolveGuideline(
		proposedGuideline: string,
		existingGuidelines: SemanticFact[],
	): Promise<GuidelineResolution> {
		return this.llm.chatStructured<GuidelineResolution>(
			buildGuidelineResolutionMessages(
				this.characterDefinition,
				existingGuidelines,
				proposedGuideline,
			),
			guidelineResolutionSchema,
		);
	}

	private async applyGuidelineResolution(input: GuidelineApplicationInput): Promise<void> {
		const { userId, guidelineFact, guidelineKeywords, resolution, existingGuidelines } = input;
		if (resolution.action === "discard") return;
		const embedding = await this.llm.embed(guidelineFact);
		const now = new Date(this.nowProvider());
		const fact = createFact({
			userId,
			category: "guideline",
			fact: guidelineFact,
			keywords: guidelineKeywords,
			sourceEpisodicIds: [],
			embedding,
			now,
			metadata: { source: "critic-auditor", guidelineAuthority: "audit-candidate" },
		});

		if (resolution.action === "replace") {
			const existingIds = new Set(existingGuidelines.map((g) => g.id));
			const targets = (resolution.targetGuidelineIds ?? []).filter((id) => existingIds.has(id));
			if (targets.length === 0) return;
			await this.storage.replaceFacts(userId, targets, fact, now);
			return;
		}

		await this.storage.saveFact(userId, fact);
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
			? guidelines
					.map((g) => `- id=${escapeXmlContent(g.id)}: ${escapeXmlContent(g.fact)}`)
					.join("\n")
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
- guidelineFact: severity が "minor" の場合、保存候補のガイドライン（日本語、省略可）
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

function buildGuidelineResolutionMessages(
	characterDefinition: string,
	guidelines: SemanticFact[],
	proposedGuideline: string,
): ChatMessage[] {
	const guidelineSection =
		guidelines.length > 0
			? guidelines
					.map(
						(g) =>
							`<guideline id="${escapeXmlContent(g.id)}" source="${escapeXmlContent(g.metadata.source ?? "unknown")}" authority="${escapeXmlContent(g.metadata.guidelineAuthority ?? "unknown")}">${escapeXmlContent(g.fact)}</guideline>`,
					)
					.join("\n")
			: "(なし)";

	const system = `あなたはキャラクター行動ガイドラインの整合性監査者です。

優先順位:
1. character_definition
2. source が unknown または consolidation の既存 guideline
3. source が critic-auditor かつ authority が audit-candidate の既存 guideline
4. 監査から生成された新しい候補 guideline

提案 guideline を保存してよいか判定してください。
- character_definition と矛盾する候補は discard
- 既存 guideline と重複する候補は discard
- 既存 guideline をより正確に置き換える候補だけ replace
- 新しく、具体的で、矛盾しない候補だけ save

<character_definition>
${escapeXmlContent(characterDefinition)}
</character_definition>

<existing_guidelines>
${guidelineSection}
</existing_guidelines>

JSON で以下を返してください:
- action: "save" | "discard" | "replace"
- reason: 日本語の短い理由
- targetGuidelineIds: action が "replace" の場合に置換対象の既存 guideline id 配列`;

	return [
		{ role: "system", content: system },
		{ role: "user", content: escapeXmlContent(proposedGuideline) },
	];
}

// ─── Schema validation ──────────────────────────────────────────

/**
 * LLM 出力の optional フィールドを寛容に扱う: 値が不正（型不一致）なら例外ではなく
 * undefined にフォールバックする。LLM の崩れた出力で CriticResult 全体が parse 失敗
 * するのを防ぐため意図的。`.catch(undefined)` は zod のフォールバック値であり無意味な
 * undefined ではない。
 */
function lenientOptional<T extends z.ZodType>(schema: T) {
	// oxlint-disable-next-line unicorn/no-useless-undefined -- zod fallback value, intentional
	return schema.optional().catch(undefined);
}

/** 配列から非 string 要素を捨てて string[] にする（lenient フィルタ） */
const stringArrayLenient = z
	.array(z.unknown())
	.transform((arr) => arr.filter((v): v is string => typeof v === "string"));

const criticResultSchema: Schema<CriticResult> = z.object({
	severity: z.enum(["none", "minor", "major"]),
	summary: z.string().min(1),
	guidelineFact: lenientOptional(z.string()),
	guidelineKeywords: lenientOptional(stringArrayLenient),
	issueTitle: lenientOptional(z.string()),
	issueBody: lenientOptional(z.string()),
});

const guidelineResolutionSchema: Schema<GuidelineResolution> = z.object({
	action: z.enum(["save", "discard", "replace"]),
	reason: z.string().min(1),
	targetGuidelineIds: lenientOptional(stringArrayLenient),
});
