/* oxlint-disable require-await, no-non-null-assertion -- test assertions */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CriticResult } from "@vicissitude/memory/critic-auditor";
import { CriticAuditor } from "@vicissitude/memory/critic-auditor";
import { DriftScoreCalculator } from "@vicissitude/memory/drift-score";
import type { MemoryLlmPort, Schema } from "@vicissitude/memory/llm-port";
import { MemoryStorage } from "@vicissitude/memory/storage";
import type { ChatMessage } from "@vicissitude/memory/types";

import { createMockLLM, makeEpisode } from "./test-helpers.ts";

const userId = "user-1";
const botName = "ふあ";
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

	test("assistant メッセージがない場合は null を返す", async () => {
		// エピソードはあるが assistant メッセージがない
		const episode = makeEpisode({
			messages: [{ role: "user", content: "hello" }],
			endAt: new Date(),
		});
		await storage.saveEpisode(userId, episode);

		const llm = createMockLLM({ structuredResponse: { severity: "none", summary: "ok" } });
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botName,
		});
		const result = await auditor.audit(userId);

		expect(result).toBeNull();
	});

	test("name が欠損または別 bot の assistant メッセージはスキップされる", async () => {
		const episode = makeEpisode({
			messages: [
				{ role: "user", content: "hello", name: "user-1" },
				{ role: "assistant", content: "I am another bot" }, // name 欠損
				{ role: "assistant", content: "I am different", name: "other-bot" }, // 別 bot
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
			botName,
		});
		const result = await auditor.audit(userId);

		// botName にマッチする assistant メッセージがないので null
		expect(result).toBeNull();
	});

	test("ドリフトスコアが低く(< 0.03)エピソード数が少ない(< 3)場合はスキップして null", async () => {
		// 低ドリフトの assistant メッセージ 1 件のみ
		const episode = makeEpisode({
			messages: [
				{ role: "user", content: "hello", name: "user-1" },
				{ role: "assistant", content: "うん", name: botName },
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
			botName,
		});
		const result = await auditor.audit(userId);

		expect(result).toBeNull();
	});

	test("ドリフトスコアが閾値以上の場合は LLM を呼んで CriticResult を返す", async () => {
		// 高ドリフトの assistant メッセージ
		const episode = makeEpisode({
			messages: [
				{ role: "user", content: "hello", name: "user-1" },
				{
					role: "assistant",
					content:
						"お手伝いします。素晴らしいご質問ですね。了解しました。もちろんです。確認してみますね。",
					name: botName,
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
			botName,
		});
		const result = await auditor.audit(userId);

		expect(result).not.toBeNull();
		expect(result!.severity).toBe("major");
		expect(result!.summary).toBe("AI assistant-like response detected");
		expect(calls).toHaveLength(1);
	});

	test('severity "minor" の場合、guideline fact が storage に保存される', async () => {
		// 十分なエピソード数(3件)を用意してコスト最適化スキップを回避
		for (let i = 0; i < 3; i++) {
			const ep = makeEpisode({
				messages: [
					{ role: "user", content: `question ${i}`, name: "user-1" },
					{ role: "assistant", content: `answer ${i}`, name: botName },
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
		const llm = createMockLLM({ structuredResponse: criticResult });
		const auditor = new CriticAuditor({
			llm,
			storage,
			driftCalculator: drift,
			characterDefinition,
			botName,
		});
		const result = await auditor.audit(userId);

		expect(result).not.toBeNull();
		expect(result!.severity).toBe("minor");

		const guidelines = await storage.getFactsByCategory(userId, "guideline");
		expect(guidelines).toHaveLength(1);
		expect(guidelines[0]!.fact).toBe("ふあは丁寧語を使わない");
		expect(guidelines[0]!.keywords).toEqual(["tone", "casual"]);
	});

	test('severity "none" の場合、fact は保存されない', async () => {
		// 十分なエピソード数を用意
		for (let i = 0; i < 3; i++) {
			const ep = makeEpisode({
				messages: [
					{ role: "user", content: `question ${i}`, name: "user-1" },
					{ role: "assistant", content: `answer ${i}`, name: botName },
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
			botName,
		});
		const result = await auditor.audit(userId);

		expect(result).not.toBeNull();
		expect(result!.severity).toBe("none");

		const guidelines = await storage.getFactsByCategory(userId, "guideline");
		expect(guidelines).toHaveLength(0);
	});
});
