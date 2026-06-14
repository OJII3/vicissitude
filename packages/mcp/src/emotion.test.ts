import { describe, expect, test } from "bun:test";

import { extractEmotionPromptErrorInfo, readEmotionEstimationConfigFromEnv } from "./emotion.ts";

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

describe("extractEmotionPromptErrorInfo", () => {
	test("OpenCode prompt failure の JSON message から 429 quota_exceeded を抽出する", () => {
		const error = new Error(
			'Prompt failed: {"name":"AI_APICallError","statusCode":429,"isRetryable":true,"headers":{"x-ratelimit-exceeded":"quota_exceeded","x-ratelimit-user-retry-after":"465000"}}',
		);
		const info = extractEmotionPromptErrorInfo(error);

		expect(info.status).toBe(429);
		expect(info.retryable).toBe(true);
		expect(info.retryAfterSeconds).toBe(465_000);
		expect(info.errorClass).toBe("AI_APICallError");
		expect(info.reason).toBe("quota_exceeded");
	});

	test("Headers オブジェクトの retry-after も抽出する", () => {
		const error = Object.assign(new Error("quota exceeded"), {
			name: "AI_APICallError",
			statusCode: 429,
			headers: new Headers({
				"retry-after": "120",
				"x-ratelimit-exceeded": "quota_exceeded",
			}),
		});
		const info = extractEmotionPromptErrorInfo(error);

		expect(info.status).toBe(429);
		expect(info.retryAfterSeconds).toBe(120);
		expect(info.reason).toBe("quota_exceeded");
	});

	test("探索キーの値が配列の場合は配列自身を展開せず要素のエラー情報も抽出しない", () => {
		// isRecord の厳格化(配列除外)により、配列はノードとして展開されず、
		// その要素も再帰探索の対象にならない。
		const error = {
			details: [{ message: "inner array message", statusCode: 429, name: "InnerError" }],
		};
		const info = extractEmotionPromptErrorInfo(error);

		expect(info.status).toBeUndefined();
		expect(info.message).toBeUndefined();
		expect(info.errorClass).toBe("Object");
		expect(info.reason).toBe("unknown");
	});

	test("cause が配列の場合も配列要素のエラー情報は抽出されない", () => {
		const error = {
			cause: [
				Object.assign(new Error("cause array message"), {
					statusCode: 503,
					name: "CauseError",
				}),
			],
		};
		const info = extractEmotionPromptErrorInfo(error);

		expect(info.status).toBeUndefined();
		expect(info.retryable).toBeUndefined();
		expect(info.message).toBeUndefined();
		expect(info.errorClass).toBe("Object");
	});

	test("トップレベルが配列でも要素を展開せず errorClass は Array になる", () => {
		const error = [{ message: "element message", statusCode: 418, name: "ElementError" }];
		const info = extractEmotionPromptErrorInfo(error);

		expect(info.status).toBeUndefined();
		expect(info.message).toBeUndefined();
		expect(info.errorClass).toBe("Array");
		expect(info.reason).toBe("unknown");
	});

	test("探索キーの値が単一レコードなら従来どおりエラー情報を抽出する", () => {
		// 配列ではなく直接レコードを置いた場合は再帰探索でき、回帰の対照となる。
		const error = {
			details: { message: "nested record message", statusCode: 500, name: "NestedError" },
		};
		const info = extractEmotionPromptErrorInfo(error);

		expect(info.status).toBe(500);
		expect(info.message).toBe("nested record message");
		expect(info.errorClass).toBe("NestedError");
	});
});
