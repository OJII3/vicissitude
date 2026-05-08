import { describe, expect, test } from "bun:test";

import { readEmotionEstimationConfigFromEnv } from "./emotion.ts";

describe("readEmotionEstimationConfigFromEnv", () => {
	test("feature が無効なら undefined を返す", () => {
		expect(readEmotionEstimationConfigFromEnv({})).toBeUndefined();
	});

	test("ollama provider は ollamaBaseUrl を読む", () => {
		const config = readEmotionEstimationConfigFromEnv({
			EMOTION_ESTIMATION_ENABLED: "true",
			EMOTION_PROVIDER_ID: "ollama",
			EMOTION_MODEL_ID: "gemma3:4b",
			EMOTION_OLLAMA_BASE_URL: "http://ollama:11434",
		});

		expect(config).toEqual({
			providerId: "ollama",
			modelId: "gemma3:4b",
			ollamaBaseUrl: "http://ollama:11434",
		});
	});

	test("ollama 以外の provider は OpenCode port を読む", () => {
		const config = readEmotionEstimationConfigFromEnv({
			EMOTION_ESTIMATION_ENABLED: "true",
			EMOTION_PROVIDER_ID: "openai",
			EMOTION_MODEL_ID: "gpt-5.4",
			EMOTION_OPENCODE_PORT: "5096",
		});

		expect(config).toEqual({
			providerId: "openai",
			modelId: "gpt-5.4",
			opencodePort: 5096,
		});
	});

	test("有効時に必須 env が足りなければエラーにする", () => {
		expect(() =>
			readEmotionEstimationConfigFromEnv({
				EMOTION_ESTIMATION_ENABLED: "true",
			}),
		).toThrow("EMOTION_PROVIDER_ID is required when emotion estimation is enabled");
	});
});
