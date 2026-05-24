import { describe, expect, test } from "bun:test";

import { createEmotionAnalyzerFromPromptPort } from "@vicissitude/mcp/emotion";
import { METRIC } from "@vicissitude/observability/metrics";
import { NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type { LlmPromptPort } from "@vicissitude/shared/ports";
import { createMockLogger, createMockMetrics } from "@vicissitude/shared/test-helpers";
import { SqliteEmotionProviderCooldownStore } from "@vicissitude/store/emotion-provider-cooldown-store";
import { createTestDb } from "@vicissitude/store/test-helpers";

function createQuotaExceededError(retryAfterSeconds: number): Error {
	const error = new Error("GitHub Copilot quota exceeded");
	return Object.assign(error, {
		name: "AI_APICallError",
		statusCode: 429,
		headers: {
			"x-ratelimit-exceeded": "quota_exceeded",
			"x-ratelimit-user-retry-after": String(retryAfterSeconds),
		},
	});
}

describe("感情推定の quota exceeded 検知", () => {
	test("429 quota_exceeded を記録し、長期 retry-after 中は同じ provider/model へ再投入しない", async () => {
		let now = 1_000_000;
		let promptCalls = 0;
		const llm: LlmPromptPort = {
			prompt(): Promise<string> {
				promptCalls += 1;
				return Promise.reject(createQuotaExceededError(465_000));
			},
		};
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const analyzer = createEmotionAnalyzerFromPromptPort(
			llm,
			{ providerId: "github-copilot", modelId: "gpt-5-mini" },
			logger,
			{
				cooldownStore: new SqliteEmotionProviderCooldownStore(createTestDb()),
				metrics,
				now: () => now,
			},
		);

		const first = await analyzer.analyze({ text: "短い返事" });

		expect(first).toEqual({ emotion: NEUTRAL_EMOTION, confidence: 0 });
		expect(promptCalls).toBe(1);
		expect(metrics.incrementCounter).toHaveBeenCalledWith(
			METRIC.EMOTION_ESTIMATION_ERRORS,
			expect.objectContaining({
				provider: "github-copilot",
				model: "gpt-5-mini",
				error_type: "rate_limit",
				http_status: "429",
				retry_after: "long",
				reason: "quota_exceeded",
			}),
		);
		expect(logger.warn).toHaveBeenCalledWith(
			"[emotion] estimation provider cooldown activated",
			expect.objectContaining({
				provider: "github-copilot",
				model: "gpt-5-mini",
				http_status: 429,
				retry_after_seconds: 465_000,
				reason: "quota_exceeded",
			}),
		);

		const second = await analyzer.analyze({ text: "もう一度返事" });

		expect(second).toEqual({ emotion: NEUTRAL_EMOTION, confidence: 0 });
		expect(promptCalls).toBe(1);
		expect(metrics.incrementCounter).toHaveBeenCalledWith(
			METRIC.EMOTION_ESTIMATION_SKIPS,
			expect.objectContaining({
				provider: "github-copilot",
				model: "gpt-5-mini",
				reason: "provider_cooldown",
			}),
		);
		expect(logger.warn).toHaveBeenCalledWith(
			"[emotion] estimation skipped during provider cooldown",
			expect.objectContaining({
				provider: "github-copilot",
				model: "gpt-5-mini",
				remaining_seconds: 465_000,
				reason: "provider_cooldown",
			}),
		);

		now += 465_001_000;
		await analyzer.analyze({ text: "待機後の返事" });
		expect(promptCalls).toBe(2);
	});

	test("cooldown は同じ provider/model の analyzer インスタンス間で共有される", async () => {
		let now = 1_000_000;
		let firstPromptCalls = 0;
		let secondPromptCalls = 0;
		const db = createTestDb();
		const model = { providerId: "github-copilot", modelId: "gpt-5-mini" };
		const firstStore = new SqliteEmotionProviderCooldownStore(db);
		const secondStore = new SqliteEmotionProviderCooldownStore(db);
		const firstAnalyzer = createEmotionAnalyzerFromPromptPort(
			{
				prompt(): Promise<string> {
					firstPromptCalls += 1;
					return Promise.reject(createQuotaExceededError(465_000));
				},
			},
			model,
			createMockLogger(),
			{ cooldownStore: firstStore, now: () => now },
		);
		const secondAnalyzer = createEmotionAnalyzerFromPromptPort(
			{
				prompt(): Promise<string> {
					secondPromptCalls += 1;
					return Promise.resolve(
						JSON.stringify({
							valence: 0,
							arousal: 0,
							dominance: 0,
							confidence: 1,
						}),
					);
				},
			},
			model,
			createMockLogger(),
			{ cooldownStore: secondStore, now: () => now },
		);

		await firstAnalyzer.analyze({ text: "最初の失敗" });
		const result = await secondAnalyzer.analyze({ text: "別プロセス相当の再投入" });

		expect(result).toEqual({ emotion: NEUTRAL_EMOTION, confidence: 0 });
		expect(firstPromptCalls).toBe(1);
		expect(secondPromptCalls).toBe(0);

		now += 465_001_000;
		await secondAnalyzer.analyze({ text: "cooldown 後の再投入" });
		expect(secondPromptCalls).toBe(1);
	});
});
