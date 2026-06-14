/* oxlint-disable no-non-null-assertion -- test assertions on fixed content shape */
import { describe, expect, it } from "bun:test";

import { errorContent, resolveBoundScope, textContent } from "@vicissitude/mcp/tools/result";

// ─── textContent ────────────────────────────────────────────────

describe("textContent", () => {
	it("テキストを type:text の content 配列に包んで返す", () => {
		const result = textContent("hello");

		expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
	});

	it("isError を付けない", () => {
		const result = textContent("hello");

		expect(result.isError).toBeUndefined();
	});

	it("空文字でも content を返す", () => {
		const result = textContent("");

		expect(result.content[0]!.text).toBe("");
	});
});

// ─── errorContent ───────────────────────────────────────────────

describe("errorContent", () => {
	it("デフォルトでは isError を付けない（既存挙動の保存）", () => {
		const result = errorContent("Error: scope_id is required");

		expect(result).toEqual({
			content: [{ type: "text", text: "Error: scope_id is required" }],
		});
		expect(result.isError).toBeUndefined();
	});

	it("第2引数 true で isError: true を付ける", () => {
		const result = errorContent("Error: namespace could not be resolved", true);

		expect(result).toEqual({
			content: [{ type: "text", text: "Error: namespace could not be resolved" }],
			isError: true,
		});
	});

	it("第2引数 false では isError を付けない", () => {
		const result = errorContent("Error: guild_id is required", false);

		expect(result.isError).toBeUndefined();
	});

	it("テキストをそのまま content に格納する", () => {
		const result = errorContent("custom error message");

		expect(result.content[0]!.text).toBe("custom error message");
		expect(result.content[0]!.type).toBe("text");
	});
});

// ─── resolveBoundScope ──────────────────────────────────────────

describe("resolveBoundScope", () => {
	it("bound 値があればそれを解決値として返す", () => {
		const result = resolveBoundScope("bound-id", "input-id", "Error: scope_id is required");

		expect(result).toEqual({ ok: true, value: "bound-id" });
	});

	it("bound 値が無く input 値があれば input を解決値として返す", () => {
		const result = resolveBoundScope(undefined, "input-id", "Error: scope_id is required");

		expect(result).toEqual({ ok: true, value: "input-id" });
	});

	it("bound 値を input 値より優先する", () => {
		const result = resolveBoundScope("bound-id", "input-id", "Error: scope_id is required");

		expect(result).toMatchObject({ ok: true, value: "bound-id" });
	});

	it("どちらも無ければ ok:false とエラー結果を返す", () => {
		const result = resolveBoundScope(undefined, undefined, "Error: scope_id is required");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.result).toEqual({
				content: [{ type: "text", text: "Error: scope_id is required" }],
			});
		}
	});

	it("解決失敗時のエラー結果はデフォルトで isError を付けない（既存ガード挙動の保存）", () => {
		const result = resolveBoundScope(undefined, undefined, "Error: guild_id is required");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.result.isError).toBeUndefined();
		}
	});

	it("isError=true 指定時はエラー結果に isError: true を付ける", () => {
		const result = resolveBoundScope(undefined, undefined, "Error: scope is required", true);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.result.isError).toBe(true);
		}
	});

	it("空文字の input は未指定として扱いエラーを返す", () => {
		const result = resolveBoundScope(undefined, "", "Error: scope_id is required");

		expect(result.ok).toBe(false);
	});
});
