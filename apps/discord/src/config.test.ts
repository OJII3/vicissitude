import { describe, expect, test } from "bun:test";

import { loadConfig } from "./config.ts";

const BASE_ENV = {
	DISCORD_TOKEN: "token",
};

describe("loadConfig feature settings", () => {
	test("デフォルトでは感情推定を無効にする", () => {
		const config = loadConfig(BASE_ENV, "/app");

		expect(config.emotionEstimation).toBeUndefined();
	});

	test("感情推定は有効化時だけ env から読み込む", () => {
		const config = loadConfig(
			{
				...BASE_ENV,
				EMOTION_ESTIMATION_ENABLED: "true",
				EMOTION_PROVIDER_ID: "ollama",
				EMOTION_MODEL_ID: "emotion-model",
				EMOTION_OLLAMA_BASE_URL: "http://emotion-ollama:11434",
			},
			"/app",
		);

		expect(config.emotionEstimation).toEqual({
			enabled: true,
			providerId: "ollama",
			modelId: "emotion-model",
			ollamaBaseUrl: "http://emotion-ollama:11434",
		});
	});

	test("感情推定が ollama の場合は OLLAMA_BASE_URL を既定値にする", () => {
		const config = loadConfig(
			{
				...BASE_ENV,
				EMOTION_ESTIMATION_ENABLED: "true",
				EMOTION_PROVIDER_ID: "ollama",
				EMOTION_MODEL_ID: "emotion-model",
				OLLAMA_BASE_URL: "http://shared-ollama:11434",
			},
			"/app",
		);

		expect(config.emotionEstimation?.ollamaBaseUrl).toBe("http://shared-ollama:11434");
	});

	test("感情推定で ollama 以外の provider を指定できる", () => {
		const config = loadConfig(
			{
				...BASE_ENV,
				EMOTION_ESTIMATION_ENABLED: "1",
				EMOTION_PROVIDER_ID: "openai",
				EMOTION_MODEL_ID: "gpt-5.4",
			},
			"/app",
		);

		expect(config.emotionEstimation).toEqual({
			enabled: true,
			providerId: "openai",
			modelId: "gpt-5.4",
			ollamaBaseUrl: undefined,
		});
	});

	test("デフォルトでは画像認識補助を無効にする", () => {
		const config = loadConfig(BASE_ENV, "/app");

		expect(config.imageRecognition).toBeUndefined();
	});

	test("有効化時は provider と model を読み込む", () => {
		const config = loadConfig(
			{
				...BASE_ENV,
				OPENCODE_PROVIDER_ID: "main-provider",
				DISCORD_IMAGE_RECOGNITION_ENABLED: "true",
				DISCORD_IMAGE_RECOGNITION_PROVIDER_ID: "vision-provider",
				DISCORD_IMAGE_RECOGNITION_MODEL_ID: "vision-model",
			},
			"/app",
		);

		expect(config.imageRecognition).toEqual({
			enabled: true,
			providerId: "vision-provider",
			modelId: "vision-model",
		});
	});

	test("有効化時に provider 未指定なら OPENCODE_PROVIDER_ID を使う", () => {
		const config = loadConfig(
			{
				...BASE_ENV,
				OPENCODE_PROVIDER_ID: "main-provider",
				DISCORD_IMAGE_RECOGNITION_ENABLED: "1",
				DISCORD_IMAGE_RECOGNITION_MODEL_ID: "vision-model",
			},
			"/app",
		);

		expect(config.imageRecognition?.providerId).toBe("main-provider");
	});

	test("有効化時に model 未指定なら設定エラーにする", () => {
		expect(() =>
			loadConfig(
				{
					...BASE_ENV,
					DISCORD_IMAGE_RECOGNITION_ENABLED: "true",
				},
				"/app",
			),
		).toThrow("DISCORD_IMAGE_RECOGNITION_MODEL_ID is required");
	});
});
