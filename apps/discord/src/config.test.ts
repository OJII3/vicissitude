import { describe, expect, test } from "bun:test";

import { loadConfig } from "./config.ts";

const BASE_ENV = {
	DISCORD_TOKEN: "token",
};

describe("loadConfig imageRecognition", () => {
	test("感情推定モデルは env から読み込む", () => {
		const config = loadConfig(
			{
				...BASE_ENV,
				EMOTION_CHAT_MODEL: "emotion-model",
				EMOTION_OLLAMA_BASE_URL: "http://emotion-ollama:11434",
			},
			"/app",
		);

		expect(config.emotion).toEqual({
			providerId: "ollama",
			modelId: "emotion-model",
			ollamaBaseUrl: "http://emotion-ollama:11434",
		});
	});

	test("感情推定モデルの base URL は OLLAMA_BASE_URL を既定値にする", () => {
		const config = loadConfig(
			{
				...BASE_ENV,
				OLLAMA_BASE_URL: "http://shared-ollama:11434",
			},
			"/app",
		);

		expect(config.emotion.ollamaBaseUrl).toBe("http://shared-ollama:11434");
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
