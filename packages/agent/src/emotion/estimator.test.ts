import { describe, expect, test } from "bun:test";

import { NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type { LlmPromptPort } from "@vicissitude/shared/ports";
import { createMockLogger } from "@vicissitude/shared/test-helpers";

import { EmotionEstimator } from "./estimator.ts";

describe("EmotionEstimator", () => {
	test("LLM 呼び出しが失敗した場合は neutral を返して warn ログを出す", async () => {
		const error = new Error("model unavailable");
		const llm: LlmPromptPort = {
			prompt(): Promise<string> {
				return Promise.reject(error);
			},
		};
		const logger = createMockLogger();
		const estimator = new EmotionEstimator(llm, logger);

		const result = await estimator.analyze({ text: "hello" });

		expect(result).toEqual({ emotion: NEUTRAL_EMOTION, confidence: 0 });
		expect(logger.warn).toHaveBeenCalledWith("[emotion] estimation failed:", error);
	});

	test("観測済みエラーは neutral を返すが warn ログを重複出力しない", async () => {
		const error = Object.assign(new Error("observed provider failure"), {
			suppressEmotionEstimatorLog: true,
		});
		const llm: LlmPromptPort = {
			prompt(): Promise<string> {
				return Promise.reject(error);
			},
		};
		const logger = createMockLogger();
		const estimator = new EmotionEstimator(llm, logger);

		const result = await estimator.analyze({ text: "hello" });

		expect(result).toEqual({ emotion: NEUTRAL_EMOTION, confidence: 0 });
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
