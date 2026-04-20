import { describe, expect, test } from "bun:test";

import { classifyErrorType } from "./metrics";

describe("classifyErrorType", () => {
	describe("status 429 → rate_limit", () => {
		test("status が 429 のとき rate_limit を返す", () => {
			expect(classifyErrorType({ status: 429 })).toBe("rate_limit");
		});

		test("status 429 は message パターンより優先される", () => {
			expect(classifyErrorType({ status: 429, message: "context_length exceeded" })).toBe(
				"rate_limit",
			);
			expect(classifyErrorType({ status: 429, message: "timeout" })).toBe("rate_limit");
		});
	});

	describe("status が 429 以外のとき rate_limit にならない", () => {
		test.each([200, 400, 500, 0])("status %d は rate_limit にならない", (status) => {
			expect(classifyErrorType({ status })).toBe("session_error");
		});
	});

	describe("message が undefined の場合", () => {
		test("message なしのとき session_error を返す", () => {
			expect(classifyErrorType({})).toBe("session_error");
		});

		test("message が undefined で status も 429 以外のとき session_error を返す", () => {
			expect(classifyErrorType({ status: 500, message: undefined })).toBe("session_error");
		});
	});

	describe("大文字小文字の混在", () => {
		test("CONTEXT_LENGTH（大文字）→ context_length_exceeded", () => {
			expect(classifyErrorType({ message: "CONTEXT_LENGTH exceeded" })).toBe(
				"context_length_exceeded",
			);
		});

		test("Max_Tokens（混在ケース）→ context_length_exceeded", () => {
			expect(classifyErrorType({ message: "Max_Tokens limit reached" })).toBe(
				"context_length_exceeded",
			);
		});

		test("TIMED OUT（大文字）→ timeout", () => {
			expect(classifyErrorType({ message: "TIMED OUT" })).toBe("timeout");
		});

		test("CONTENT_FILTER（大文字）→ content_filter", () => {
			expect(classifyErrorType({ message: "CONTENT_FILTER triggered" })).toBe("content_filter");
		});

		test("Content_Management（混在ケース）→ content_filter", () => {
			expect(classifyErrorType({ message: "Content_Management policy" })).toBe("content_filter");
		});
	});

	describe("複数パターンが同時に含まれる場合の優先順位", () => {
		test("context_length と timeout が両方含まれる → context_length_exceeded（先にマッチ）", () => {
			expect(classifyErrorType({ message: "context_length timeout error" })).toBe(
				"context_length_exceeded",
			);
		});

		test("max_tokens と content_filter が両方含まれる → context_length_exceeded（先にマッチ）", () => {
			expect(classifyErrorType({ message: "max_tokens content_filter" })).toBe(
				"context_length_exceeded",
			);
		});

		test("content_filter と timeout が両方含まれる → content_filter（先にマッチ）", () => {
			expect(classifyErrorType({ message: "content_filter timed out" })).toBe("content_filter");
		});
	});

	describe("timeout の部分一致", () => {
		test("read_timeout_error → timeout に分類される", () => {
			expect(classifyErrorType({ message: "read_timeout_error" })).toBe("timeout");
		});

		test("connection_timed out → timeout に分類される", () => {
			expect(classifyErrorType({ message: "connection_timed out" })).toBe("timeout");
		});
	});

	describe("retryable・errorClass は分類に影響しない", () => {
		test("retryable: true でも message ベースの分類が変わらない", () => {
			expect(classifyErrorType({ retryable: true, message: "timeout" })).toBe("timeout");
		});

		test("retryable: false でも message ベースの分類が変わらない", () => {
			expect(classifyErrorType({ retryable: false, message: "context_length" })).toBe(
				"context_length_exceeded",
			);
		});

		test("errorClass が指定されていても分類に影響しない", () => {
			expect(classifyErrorType({ errorClass: "RateLimitError", message: "something failed" })).toBe(
				"session_error",
			);
		});

		test("retryable と errorClass の両方があっても message ベースで分類される", () => {
			expect(
				classifyErrorType({
					retryable: true,
					errorClass: "TimeoutError",
					message: "content_filter blocked",
				}),
			).toBe("content_filter");
		});
	});

	describe("デフォルト分類", () => {
		test("どのパターンにもマッチしない message → session_error", () => {
			expect(classifyErrorType({ message: "unknown error occurred" })).toBe("session_error");
		});

		test("空文字の message → session_error", () => {
			expect(classifyErrorType({ message: "" })).toBe("session_error");
		});
	});
});
