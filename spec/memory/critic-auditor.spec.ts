/* oxlint-disable require-await, no-non-null-assertion, max-lines-per-function -- test assertions */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CriticResult, GuidelineResolution } from "@vicissitude/memory/critic-auditor";
import { CriticAuditor } from "@vicissitude/memory/critic-auditor";
import { DriftScoreCalculator } from "@vicissitude/memory/drift-score";
import type { MemoryLlmPort, Schema } from "@vicissitude/memory/llm-port";
import { createFact } from "@vicissitude/memory/semantic-fact";
import { MemoryStorage } from "@vicissitude/memory/storage";
import type { ChatMessage } from "@vicissitude/memory/types";

import { createMockLLM, makeEpisode } from "./test-helpers.ts";

const userId = "user-1";
const botUserId = "1100000000000000001";
const characterDefinition = "You are hua, a casual and snarky girl.";

/** LLM that records chatStructured calls for inspection */
function createSpyLLM(criticResponse: CriticResult) {
	const calls: { messages: ChatMessage[] }[] = [];
	const llm: MemoryLlmPort = {
		async chat(): Promise<string> {
			return "mock";
		},
		async chatStructured<T>(messages: ChatMessage[], schema: Schema<T>): Promise<T> {
			calls.push({ messages });
			return schema.parse(criticResponse);
		},
		async embed(): Promise<number[]> {
			return [0.1, 0.2, 0.3];
		},
	};
	return { llm, calls };
}

function createSequentialStructuredLLM(responses: unknown[]) {
	const calls: { messages: ChatMessage[] }[] = [];
	const llm: MemoryLlmPort = {
		async chat(): Promise<string> {
			return "mock";
		},
		async chatStructured<T>(messages: ChatMessage[], schema: Schema<T>): Promise<T> {
			calls.push({ messages });
			const response = responses.shift();
			if (response === undefined) throw new Error("unexpected chatStructured call");
			return schema.parse(response);
		},
		async embed(): Promise<number[]> {
			return [0.1, 0.2, 0.3];
		},
	};
	return { llm, calls };
}

async function saveExistingGuideline(storage: MemoryStorage, fact: string) {
	const guideline = createFact({
		userId,
		category: "guideline",
		fact,
		keywords: ["tone"],
		sourceEpisodicIds: ["ep-1"],
		embedding: [0.1, 0.2, 0.3],
		now: new Date("2026-01-01T00:00:00Z"),
	});
	await storage.saveFact(userId, guideline);
	return guideline;
}

async function saveAuditCandidateGuideline(storage: MemoryStorage, fact: string) {
	const guideline = createFact({
		userId,
		category: "guideline",
		fact,
		keywords: ["tone"],
		sourceEpisodicIds: [],
		embedding: [0.1, 0.2, 0.3],
		now: new Date("2026-01-01T00:00:00Z"),
		metadata: { source: "critic-auditor", guidelineAuthority: "audit-candidate" },
	});
	await storage.saveFact(userId, guideline);
	return guideline;
}

describe("CriticAuditor", () => {
	let storage: MemoryStorage;
	let drift: DriftScoreCalculator;

	beforeEach(async () => {
		storage = new MemoryStorage(":memory:");
		drift = new DriftScoreCalculator(createMockLLM(), "");
		await drift.init();
	});

	afterEach(() => {
		storage.close();
	});

	test("assistant メッセージがない場合は no_messages skip を返す", async () => {
		// エピソードはあるが assistant メッセージがない
		const episode = makeEpisode({
			messages: [{ role: "user", content: "hello", authorId: "user-1" }],
			endAt: new Date(),
		});
		await storage.saveEpisode(userId, episode);

		const llm = createMockLLM({ structuredResponse: { severity: "none", summary: "ok" } });
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		expect(result).toEqual({ status: "skipped", reason: "no_messages" });
	});

	test("authorId が欠損または別 bot の assistant メッセージはスキップされる", async () => {
		const episode = makeEpisode({
			messages: [
				{ role: "user", content: "hello", authorId: "user-1", name: "user-1" },
				// authorId 欠損（旧データや他経路で挿入されたデータ）
				{ role: "assistant", content: "I am another bot", name: "ふあ" },
				// 別 bot user
				{
					role: "assistant",
					content: "I am different",
					authorId: "9999999999999999999",
					name: "ふあ",
				},
			],
			endAt: new Date(),
		});
		await storage.saveEpisode(userId, episode);

		const llm = createMockLLM({ structuredResponse: { severity: "none", summary: "ok" } });
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		// botUserId にマッチする assistant メッセージがないので no_messages
		expect(result).toEqual({ status: "skipped", reason: "no_messages" });
	});

	test("name が一致しても authorId が一致しなければスキップされる（ニックネーム不一致対策）", async () => {
		// 同名（ふあ）の別 bot が同一 guild にいるケース。authorId が異なれば除外される。
		const episode = makeEpisode({
			messages: [
				{ role: "user", content: "hello", authorId: "user-1", name: "user-1" },
				{
					role: "assistant",
					content: "別 bot の発話",
					authorId: "8888888888888888888",
					name: "ふあ",
				},
			],
			endAt: new Date(),
		});
		await storage.saveEpisode(userId, episode);

		const llm = createMockLLM({ structuredResponse: { severity: "none", summary: "ok" } });
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		expect(result).toEqual({ status: "skipped", reason: "no_messages" });
	});

	test("ドリフトスコアが低く(< 0.03)エピソード数が少ない(< 3)場合は low_drift skip を返す", async () => {
		// 低ドリフトの assistant メッセージ 1 件のみ
		const episode = makeEpisode({
			messages: [
				{ role: "user", content: "hello", authorId: "user-1", name: "user-1" },
				{ role: "assistant", content: "うん", authorId: botUserId, name: "ふあ" },
			],
			endAt: new Date(),
		});
		await storage.saveEpisode(userId, episode);

		const llm = createMockLLM({ structuredResponse: { severity: "none", summary: "ok" } });
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		expect(result).toEqual({ status: "skipped", reason: "low_drift", driftScore: 0 });
	});

	test("ドリフトスコアが閾値以上の場合は LLM を呼んで CriticResult を返す（authorId でフィルタ）", async () => {
		// 高ドリフトの assistant メッセージ。guild ニックネーム（name）は異なっても authorId が一致すれば対象。
		const episode = makeEpisode({
			messages: [
				{ role: "user", content: "hello", authorId: "user-1", name: "user-1" },
				{
					role: "assistant",
					content:
						"お手伝いします。素晴らしいご質問ですね。了解しました。もちろんです。確認してみますね。",
					// ニックネームが "hua-bot" になっていても authorId が一致すれば対象になる
					authorId: botUserId,
					name: "hua-bot",
				},
			],
			endAt: new Date(),
		});
		await storage.saveEpisode(userId, episode);

		const criticResult: CriticResult = {
			severity: "major",
			summary: "AI assistant-like response detected",
		};
		const { llm, calls } = createSpyLLM(criticResult);
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		expect(result.status).toBe("completed");
		if (result.status !== "completed") throw new Error("expected completed audit");
		expect(result.severity).toBe("major");
		expect(result.summary).toBe("AI assistant-like response detected");
		expect(calls).toHaveLength(1);
	});

	test('severity "minor" の場合、解決結果が save なら audit-candidate guideline が保存される', async () => {
		// 十分なエピソード数(3件)を用意してコスト最適化スキップを回避
		for (let i = 0; i < 3; i++) {
			const ep = makeEpisode({
				messages: [
					{ role: "user", content: `question ${i}`, authorId: "user-1", name: "user-1" },
					{ role: "assistant", content: `answer ${i}`, authorId: botUserId, name: "ふあ" },
				],
				endAt: new Date(),
			});
			/* oxlint-disable-next-line no-await-in-loop -- test setup */
			await storage.saveEpisode(userId, ep);
		}

		const criticResult: CriticResult = {
			severity: "minor",
			summary: "Slightly too polite",
			guidelineFact: "ふあは丁寧語を使わない",
			guidelineKeywords: ["tone", "casual"],
		};
		const resolution: GuidelineResolution = {
			action: "save",
			reason: "新しく具体的な候補",
		};
		const { llm } = createSequentialStructuredLLM([criticResult, resolution]);
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		expect(result.status).toBe("completed");
		if (result.status !== "completed") throw new Error("expected completed audit");
		expect(result.severity).toBe("minor");

		const guidelines = await storage.getFactsByCategory(userId, "guideline");
		expect(guidelines).toHaveLength(1);
		expect(guidelines[0]!.fact).toBe("ふあは丁寧語を使わない");
		expect(guidelines[0]!.keywords).toEqual(["tone", "casual"]);
		expect(guidelines[0]!.metadata).toEqual({
			source: "critic-auditor",
			guidelineAuthority: "audit-candidate",
		});
		expect(result.guidelineResolution).toEqual(resolution);
	});

	test('severity "minor" の場合、解決結果が discard なら guideline は保存されない', async () => {
		for (let i = 0; i < 3; i++) {
			const ep = makeEpisode({
				messages: [
					{ role: "user", content: `question ${i}`, authorId: "user-1", name: "user-1" },
					{ role: "assistant", content: `answer ${i}`, authorId: botUserId, name: "ふあ" },
				],
				endAt: new Date(),
			});
			/* oxlint-disable-next-line no-await-in-loop -- test setup */
			await storage.saveEpisode(userId, ep);
		}

		const existing = await saveExistingGuideline(storage, "ふあは丁寧語を使わない");
		const criticResult: CriticResult = {
			severity: "minor",
			summary: "Slightly too polite",
			guidelineFact: "ふあは丁寧語を使わない",
			guidelineKeywords: ["tone", "casual"],
		};
		const resolution: GuidelineResolution = {
			action: "discard",
			reason: "既存 guideline と重複している",
		};
		const { llm } = createSequentialStructuredLLM([criticResult, resolution]);
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		expect(result.status).toBe("completed");
		if (result.status !== "completed") throw new Error("expected completed audit");
		expect(result.guidelineResolution).toEqual(resolution);

		const guidelines = await storage.getFactsByCategory(userId, "guideline");
		expect(guidelines).toHaveLength(1);
		expect(guidelines[0]!.id).toBe(existing.id);
	});

	test("guideline 解決プロンプトには既存 guideline の metadata が含まれる", async () => {
		for (let i = 0; i < 3; i++) {
			const ep = makeEpisode({
				messages: [
					{ role: "user", content: `question ${i}`, authorId: "user-1", name: "user-1" },
					{ role: "assistant", content: `answer ${i}`, authorId: botUserId, name: "ふあ" },
				],
				endAt: new Date(),
			});
			/* oxlint-disable-next-line no-await-in-loop -- test setup */
			await storage.saveEpisode(userId, ep);
		}

		await saveAuditCandidateGuideline(storage, "ふあは丁寧語を使わない");
		const criticResult: CriticResult = {
			severity: "minor",
			summary: "Slightly too polite",
			guidelineFact: "ふあはチャットボット的な丁寧語を避ける",
		};
		const resolution: GuidelineResolution = {
			action: "discard",
			reason: "既存候補と重複している",
		};
		const { llm, calls } = createSequentialStructuredLLM([criticResult, resolution]);
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		await auditor.audit(userId);

		expect(calls).toHaveLength(2);
		const resolutionPrompt = calls[1]?.messages[0]?.content ?? "";
		expect(resolutionPrompt).toContain('source="critic-auditor"');
		expect(resolutionPrompt).toContain('authority="audit-candidate"');
	});

	test('severity "minor" の場合、解決結果が replace なら対象 guideline を無効化して候補を保存する', async () => {
		for (let i = 0; i < 3; i++) {
			const ep = makeEpisode({
				messages: [
					{ role: "user", content: `question ${i}`, authorId: "user-1", name: "user-1" },
					{ role: "assistant", content: `answer ${i}`, authorId: botUserId, name: "ふあ" },
				],
				endAt: new Date(),
			});
			/* oxlint-disable-next-line no-await-in-loop -- test setup */
			await storage.saveEpisode(userId, ep);
		}

		const existing = await saveExistingGuideline(storage, "ふあは少し丁寧に話す");
		const criticResult: CriticResult = {
			severity: "minor",
			summary: "Slightly too polite",
			guidelineFact: "ふあはチャットボット的な丁寧語を避ける",
			guidelineKeywords: ["tone", "casual"],
		};
		const resolution: GuidelineResolution = {
			action: "replace",
			reason: "既存 guideline をより正確にする",
			targetGuidelineIds: [existing.id],
		};
		const { llm } = createSequentialStructuredLLM([criticResult, resolution]);
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		expect(result.status).toBe("completed");
		if (result.status !== "completed") throw new Error("expected completed audit");
		expect(result.guidelineResolution).toEqual(resolution);

		const activeGuidelines = await storage.getFactsByCategory(userId, "guideline");
		expect(activeGuidelines).toHaveLength(1);
		expect(activeGuidelines[0]!.id).not.toBe(existing.id);
		expect(activeGuidelines[0]!.fact).toBe("ふあはチャットボット的な丁寧語を避ける");
	});

	test('severity "none" の場合、fact は保存されない', async () => {
		// 十分なエピソード数を用意
		for (let i = 0; i < 3; i++) {
			const ep = makeEpisode({
				messages: [
					{ role: "user", content: `question ${i}`, authorId: "user-1", name: "user-1" },
					{ role: "assistant", content: `answer ${i}`, authorId: botUserId, name: "ふあ" },
				],
				endAt: new Date(),
			});
			/* oxlint-disable-next-line no-await-in-loop -- test setup */
			await storage.saveEpisode(userId, ep);
		}

		const criticResult: CriticResult = {
			severity: "none",
			summary: "Character is consistent",
		};
		const llm = createMockLLM({ structuredResponse: criticResult });
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botUserId,
		});
		const result = await auditor.audit(userId);

		expect(result.status).toBe("completed");
		if (result.status !== "completed") throw new Error("expected completed audit");
		expect(result.severity).toBe("none");

		const guidelines = await storage.getFactsByCategory(userId, "guideline");
		expect(guidelines).toHaveLength(0);
	});
});
