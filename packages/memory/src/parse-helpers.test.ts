/* oxlint-disable no-non-null-assertion -- test assertions */
import { describe, expect, test } from "bun:test";

import {
	parseJson,
	validateCategory,
	validateEmbedding,
	validateMessages,
	validateRole,
	validateStringArray,
} from "./parse-helpers.ts";

describe("parseJson", () => {
	test("parses valid JSON", () => {
		expect(parseJson('{"a":1}', "test")).toEqual({ a: 1 });
	});

	test("throws on invalid JSON", () => {
		expect(() => parseJson("{bad", "field")).toThrow("Failed to parse field");
	});

	test("throws on empty string", () => {
		expect(() => parseJson("", "field")).toThrow("Failed to parse field");
	});
});

describe("validateRole", () => {
	test("accepts valid roles", () => {
		expect(validateRole("system")).toBe("system");
		expect(validateRole("user")).toBe("user");
		expect(validateRole("assistant")).toBe("assistant");
	});

	test("rejects invalid role string", () => {
		expect(() => validateRole("admin")).toThrow("role: expected one of");
	});

	test("rejects non-string", () => {
		expect(() => validateRole(42)).toThrow("role: expected one of");
	});
});

describe("validateCategory", () => {
	const validCategories = [
		"identity",
		"preference",
		"interest",
		"personality",
		"relationship",
		"experience",
		"goal",
		"guideline",
	] as const;

	for (const cat of validCategories) {
		test(`accepts "${cat}"`, () => {
			expect(validateCategory(cat)).toBe(cat);
		});
	}

	test("rejects invalid category", () => {
		expect(() => validateCategory("unknown")).toThrow("category: expected one of");
	});

	test("rejects non-string", () => {
		expect(() => validateCategory(123)).toThrow("category: expected one of");
	});
});

describe("validateMessages", () => {
	test("validates a well-formed message array", () => {
		const result = validateMessages([{ role: "user", content: "hello" }]);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("user");
		expect(result[0]!.content).toBe("hello");
	});

	test("throws on non-array input", () => {
		expect(() => validateMessages("not-array")).toThrow("messages: expected array");
	});

	test("throws on null element", () => {
		expect(() => validateMessages([null])).toThrow("messages[0]: expected object");
	});

	test("throws when role is missing", () => {
		expect(() => validateMessages([{ content: "hello" }])).toThrow("role: expected one of");
	});

	test("throws when content is missing", () => {
		expect(() => validateMessages([{ role: "user" }])).toThrow("expected content string");
	});

	test("throws on invalid role value", () => {
		expect(() => validateMessages([{ role: "admin", content: "hello" }])).toThrow(
			"role: expected one of",
		);
	});

	test("parses string timestamp", () => {
		const result = validateMessages([
			{ role: "user", content: "hi", timestamp: "2026-01-01T00:00:00Z" },
		]);
		expect(result[0]!.timestamp).toBeInstanceOf(Date);
	});

	test("parses numeric timestamp", () => {
		const ts = Date.now();
		const result = validateMessages([{ role: "user", content: "hi", timestamp: ts }]);
		expect(result[0]!.timestamp!.getTime()).toBe(ts);
	});

	test("throws on invalid timestamp type", () => {
		expect(() => validateMessages([{ role: "user", content: "hi", timestamp: true }])).toThrow(
			"timestamp: expected string or number",
		);
	});

	test("omits timestamp when absent", () => {
		const result = validateMessages([{ role: "user", content: "hi" }]);
		expect(result[0]!.timestamp).toBeUndefined();
	});

	test("preserves name when present as string", () => {
		const result = validateMessages([{ role: "user", content: "hello", name: "Alice" }]);
		expect(result[0]!.name).toBe("Alice");
	});

	test("omits name when absent", () => {
		const result = validateMessages([{ role: "user", content: "hello" }]);
		expect(result[0]!.name).toBeUndefined();
	});

	test("omits name when not a string", () => {
		const result = validateMessages([{ role: "user", content: "hello", name: 42 }]);
		expect(result[0]!.name).toBeUndefined();
	});

	test("omits name when null", () => {
		const result = validateMessages([{ role: "user", content: "hello", name: null }]);
		expect(result[0]!.name).toBeUndefined();
	});

	test("strips control characters from name", () => {
		const result = validateMessages([{ role: "user", content: "hello", name: "Alice\nBob\t\r" }]);
		expect(result[0]!.name).toBe("AliceBob");
	});

	test("throws when name exceeds max length", () => {
		const longName = "A".repeat(101);
		expect(() => validateMessages([{ role: "user", content: "hello", name: longName }])).toThrow(
			"name: too long",
		);
	});

	describe("authorId validation", () => {
		test("preserves a short authorId", () => {
			const result = validateMessages([{ role: "user", content: "hi", authorId: "user-123" }]);
			expect(result[0]!.authorId).toBe("user-123");
		});

		test("preserves a Discord snowflake (18 digits)", () => {
			const snowflake = "123456789012345678";
			const result = validateMessages([{ role: "user", content: "hi", authorId: snowflake }]);
			expect(result[0]!.authorId).toBe(snowflake);
		});

		test("preserves a Discord snowflake (20 digits)", () => {
			const snowflake = "12345678901234567890";
			const result = validateMessages([{ role: "user", content: "hi", authorId: snowflake }]);
			expect(result[0]!.authorId).toBe(snowflake);
		});

		test("accepts authorId of exactly 64 characters", () => {
			const id = "a".repeat(64);
			const result = validateMessages([{ role: "user", content: "hi", authorId: id }]);
			expect(result[0]!.authorId).toBe(id);
		});

		test("throws when authorId exceeds 64 characters", () => {
			const id = "a".repeat(65);
			expect(() => validateMessages([{ role: "user", content: "hi", authorId: id }])).toThrow(
				"authorId: too long",
			);
		});

		test("treats empty string authorId as undefined", () => {
			const result = validateMessages([{ role: "user", content: "hi", authorId: "" }]);
			expect(result[0]!.authorId).toBeUndefined();
			expect("authorId" in result[0]!).toBe(false);
		});

		test("omits authorId when absent", () => {
			const result = validateMessages([{ role: "user", content: "hi" }]);
			expect(result[0]!.authorId).toBeUndefined();
			expect("authorId" in result[0]!).toBe(false);
		});

		test("omits authorId when null", () => {
			const result = validateMessages([{ role: "user", content: "hi", authorId: null }]);
			expect(result[0]!.authorId).toBeUndefined();
			expect("authorId" in result[0]!).toBe(false);
		});

		test("omits authorId when not a string (number)", () => {
			const result = validateMessages([{ role: "user", content: "hi", authorId: 12345 }]);
			expect(result[0]!.authorId).toBeUndefined();
			expect("authorId" in result[0]!).toBe(false);
		});

		test("omits authorId when not a string (boolean)", () => {
			const result = validateMessages([{ role: "user", content: "hi", authorId: true }]);
			expect(result[0]!.authorId).toBeUndefined();
		});

		test("strips control characters from authorId", () => {
			const result = validateMessages([{ role: "user", content: "hi", authorId: "user\n123\t\r" }]);
			expect(result[0]!.authorId).toBe("user123");
		});

		test("strips DEL character (0x7F) from authorId", () => {
			const result = validateMessages([{ role: "user", content: "hi", authorId: "user\u007F456" }]);
			expect(result[0]!.authorId).toBe("user456");
		});

		test("treats control-only authorId as undefined after stripping", () => {
			const result = validateMessages([{ role: "user", content: "hi", authorId: "\n\t\r" }]);
			expect(result[0]!.authorId).toBeUndefined();
			expect("authorId" in result[0]!).toBe(false);
		});

		test("authorId length check uses raw length (before strip)", () => {
			// 65 chars total but all but one are control chars; still rejected because
			// length check happens before stripping
			// 65 chars
			const id = `${"\n".repeat(64)}a`;
			expect(() => validateMessages([{ role: "user", content: "hi", authorId: id }])).toThrow(
				"authorId: too long",
			);
		});

		test("preserves authorId alongside name and timestamp", () => {
			const result = validateMessages([
				{
					role: "user",
					content: "hi",
					name: "Alice",
					authorId: "discord-987",
					timestamp: "2026-01-01T00:00:00Z",
				},
			]);
			expect(result[0]!.name).toBe("Alice");
			expect(result[0]!.authorId).toBe("discord-987");
			expect(result[0]!.timestamp).toBeInstanceOf(Date);
		});
	});
});

describe("validateEmbedding", () => {
	test("validates a well-formed number array", () => {
		expect(validateEmbedding([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
	});

	test("throws on non-array input", () => {
		expect(() => validateEmbedding("not-array")).toThrow("embedding: expected array");
	});

	test("throws on non-number element", () => {
		expect(() => validateEmbedding([0.1, "bad"])).toThrow("embedding[1]: expected number");
	});

	test("accepts empty array", () => {
		expect(validateEmbedding([])).toEqual([]);
	});

	test("throws when exceeding max dimensions", () => {
		const huge = Array.from({ length: 4097 }, (_, i) => i);
		expect(() => validateEmbedding(huge)).toThrow("too many dimensions");
	});
});

describe("validateStringArray", () => {
	test("validates a well-formed string array", () => {
		expect(validateStringArray(["a", "b"], "test")).toEqual(["a", "b"]);
	});

	test("throws on non-array input", () => {
		expect(() => validateStringArray("not-array", "field")).toThrow("field: expected array");
	});

	test("throws on non-string element", () => {
		expect(() => validateStringArray(["a", 42], "field")).toThrow("field[1]: expected string");
	});

	test("accepts empty array", () => {
		expect(validateStringArray([], "field")).toEqual([]);
	});

	test("throws when exceeding maxLength", () => {
		expect(() => validateStringArray(["a", "b", "c"], "field", 2)).toThrow("too many elements");
	});

	test("respects maxLength when within limit", () => {
		expect(validateStringArray(["a", "b"], "field", 2)).toEqual(["a", "b"]);
	});
});
