/**
 * classifyErrorType: エラー種別の分類仕様テスト
 *
 * 期待仕様:
 * 1. status === 429 → "rate_limit"
 * 2. message に "context_length" or "max_tokens" (case-insensitive) → "context_length_exceeded"
 * 3. message に "content_filter" or "content_management" (case-insensitive) → "content_filter"
 * 4. message に "timed out" or "timeout" (case-insensitive) → "timeout"
 * 5. それ以外 → "session_error"（後方互換）
 *
 * 優先順位: 上記の番号順（status=429 が最優先）
 */
import { describe, expect, it } from "bun:test";

import { classifyErrorType } from "@vicissitude/observability/metrics";

// ─── rate_limit ─────────────────────────────────────────────────

describe("classifyErrorType: rate_limit", () => {
	it("status=429 の場合 rate_limit を返す", () => {
		expect(classifyErrorType({ status: 429 })).toBe("rate_limit");
	});

	it("status=429 で message が他のパターンに一致する場合でも rate_limit が優先される", () => {
		expect(
			classifyErrorType({ status: 429, message: "context_length exceeded" }),
		).toBe("rate_limit");
		expect(
			classifyErrorType({ status: 429, message: "content_filter triggered" }),
		).toBe("rate_limit");
		expect(
			classifyErrorType({ status: 429, message: "request timed out" }),
		).toBe("rate_limit");
	});
});

// ─── context_length_exceeded ────────────────────────────────────

describe("classifyErrorType: context_length_exceeded", () => {
	it("message に 'context_length' を含む場合 context_length_exceeded を返す", () => {
		expect(
			classifyErrorType({ status: 400, message: "context_length limit reached" }),
		).toBe("context_length_exceeded");
	});

	it("message に 'max_tokens' を含む場合（大文字小文字混在）context_length_exceeded を返す", () => {
		expect(
			classifyErrorType({ message: "Max_Tokens exceeded the model limit" }),
		).toBe("context_length_exceeded");
	});
});

// ─── content_filter ─────────────────────────────────────────────

describe("classifyErrorType: content_filter", () => {
	it("message に 'content_filter' を含む場合 content_filter を返す", () => {
		expect(
			classifyErrorType({ message: "blocked by content_filter policy" }),
		).toBe("content_filter");
	});

	it("message に 'content_management' を含む場合 content_filter を返す", () => {
		expect(
			classifyErrorType({ message: "content_management restriction applied" }),
		).toBe("content_filter");
	});
});

// ─── timeout ────────────────────────────────────────────────────

describe("classifyErrorType: timeout", () => {
	it("message に 'timed out' を含む場合 timeout を返す", () => {
		expect(
			classifyErrorType({ message: "request timed out after 30s" }),
		).toBe("timeout");
	});

	it("message に 'timeout' を含む場合 timeout を返す", () => {
		expect(
			classifyErrorType({ message: "connection timeout" }),
		).toBe("timeout");
	});
});

// ─── session_error（デフォルト）──────────────────────────────────

describe("classifyErrorType: session_error（デフォルト）", () => {
	it("status=500 で message がどのパターンにも一致しない場合 session_error を返す", () => {
		expect(
			classifyErrorType({ status: 500, message: "internal server error" }),
		).toBe("session_error");
	});

	it("全フィールドが undefined の場合 session_error を返す", () => {
		expect(classifyErrorType({})).toBe("session_error");
	});

	it("message が空文字列の場合 session_error を返す", () => {
		expect(classifyErrorType({ message: "" })).toBe("session_error");
	});
});
