import { describe, expect, test } from "bun:test";

import { evaluateProactiveCompaction, isCompactionOnCooldown } from "./runner-compaction.ts";

const base = {
	compactionTokenThreshold: 1000,
	now: 0,
	lastCompactionAt: null,
	compactionCooldownMs: 1_800_000,
	sessionCreatedAt: null,
	sessionMaxAgeMs: 3_600_000,
	tokens: undefined,
};

describe("isCompactionOnCooldown", () => {
	test("lastCompactionAt が null なら常に false", () => {
		expect(isCompactionOnCooldown(100, null, 50)).toBe(false);
	});
	test("クールダウン期間内なら true", () => {
		expect(isCompactionOnCooldown(100, 80, 50)).toBe(true);
	});
	test("クールダウン期間経過後は false", () => {
		expect(isCompactionOnCooldown(200, 80, 50)).toBe(false);
	});
});

describe("evaluateProactiveCompaction", () => {
	test("閾値未設定なら none", () => {
		expect(evaluateProactiveCompaction({ ...base, compactionTokenThreshold: undefined })).toBe(
			"none",
		);
	});
	test("クールダウン中なら cooldown", () => {
		expect(
			evaluateProactiveCompaction({
				...base,
				now: 100,
				lastCompactionAt: 50,
				compactionCooldownMs: 1000,
			}),
		).toBe("cooldown");
	});
	test("トークン閾値超過なら threshold", () => {
		expect(evaluateProactiveCompaction({ ...base, tokens: { input: 600, output: 600 } })).toBe(
			"threshold",
		);
	});
	test("深夜帯(JST 3時)かつ半寿命・半閾値なら midnight", () => {
		// JST 3:00 = UTC 18:00
		const utc3JST = Date.UTC(2026, 0, 2, 18, 0, 0);
		expect(
			evaluateProactiveCompaction({
				...base,
				now: utc3JST,
				sessionCreatedAt: utc3JST - 1_800_001,
				tokens: { input: 300, output: 300 },
			}),
		).toBe("midnight");
	});
	test("条件を満たさなければ none", () => {
		expect(evaluateProactiveCompaction({ ...base, tokens: { input: 1, output: 1 } })).toBe("none");
	});
});
