import { describe, expect, test } from "bun:test";

import { loadConfig } from "./config.ts";

const BASE_ENV = {
	DISCORD_TOKEN: "token",
};

describe("loadConfig imageRecognition", () => {
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
