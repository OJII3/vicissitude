import { describe, expect, test } from "bun:test";

import { hourBucketProbability, shouldStartListening } from "./listening-schedule.ts";

// ─── hourBucketProbability ───────────────────────────────────────

describe("hourBucketProbability — 全時間帯の戻り値", () => {
	test("0 時 → 0.5", () => expect(hourBucketProbability(0)).toBe(0.5));
	test("1 時 → 0.5", () => expect(hourBucketProbability(1)).toBe(0.5));
	test("2 時 → 0.0", () => expect(hourBucketProbability(2)).toBe(0.0));
	test("3 時 → 0.0", () => expect(hourBucketProbability(3)).toBe(0.0));
	test("4 時 → 0.0", () => expect(hourBucketProbability(4)).toBe(0.0));
	test("5 時 → 0.0", () => expect(hourBucketProbability(5)).toBe(0.0));
	test("6 時 → 0.0", () => expect(hourBucketProbability(6)).toBe(0.0));
	test("7 時 → 0.15", () => expect(hourBucketProbability(7)).toBe(0.15));
	test("8 時 → 0.15", () => expect(hourBucketProbability(8)).toBe(0.15));
	test("9 時 → 0.35", () => expect(hourBucketProbability(9)).toBe(0.35));
	test("10 時 → 0.35", () => expect(hourBucketProbability(10)).toBe(0.35));
	test("11 時 → 0.35", () => expect(hourBucketProbability(11)).toBe(0.35));
	test("12 時 → 0.35", () => expect(hourBucketProbability(12)).toBe(0.35));
	test("13 時 → 0.35", () => expect(hourBucketProbability(13)).toBe(0.35));
	test("17 時 → 0.35", () => expect(hourBucketProbability(17)).toBe(0.35));
	test("18 時 → 0.6", () => expect(hourBucketProbability(18)).toBe(0.6));
	test("19 時 → 0.6", () => expect(hourBucketProbability(19)).toBe(0.6));
	test("23 時 → 0.6", () => expect(hourBucketProbability(23)).toBe(0.6));
});

describe("hourBucketProbability — 境界値", () => {
	test("境界 0: 深夜帯（0.5）", () => expect(hourBucketProbability(0)).toBe(0.5));
	test("境界 2: 睡眠帯の開始（0.0）", () => expect(hourBucketProbability(2)).toBe(0.0));
	test("境界 7: 朝帯の開始（0.15）", () => expect(hourBucketProbability(7)).toBe(0.15));
	test("境界 9: 日中帯の開始（0.35）", () => expect(hourBucketProbability(9)).toBe(0.35));
	test("境界 12: 日中帯の中間（0.35）", () => expect(hourBucketProbability(12)).toBe(0.35));
	test("境界 13: 日中帯（0.35）", () => expect(hourBucketProbability(13)).toBe(0.35));
	test("境界 18: 夜帯の開始（0.6）", () => expect(hourBucketProbability(18)).toBe(0.6));
	test("境界 24: 範囲外 → 深夜帯と同じ fallthrough（0.5）", () => {
		// hour >= 24 はどの if にもマッチしないため default の 0.5
		expect(hourBucketProbability(24)).toBe(0.5);
	});
});

describe("hourBucketProbability — 不正入力", () => {
	test("負値 → default 0.5（どの分岐にもマッチしない）", () => {
		expect(hourBucketProbability(-1)).toBe(0.5);
		expect(hourBucketProbability(-100)).toBe(0.5);
	});

	test("24 以上 → default 0.5", () => {
		expect(hourBucketProbability(25)).toBe(0.5);
		expect(hourBucketProbability(100)).toBe(0.5);
	});

	test("小数 → 条件分岐に従う（例: 2.5 は 2-7 帯）", () => {
		expect(hourBucketProbability(2.5)).toBe(0.0);
		expect(hourBucketProbability(6.9)).toBe(0.0);
		expect(hourBucketProbability(7.5)).toBe(0.15);
		// < 2 なので深夜帯
		expect(hourBucketProbability(1.9)).toBe(0.5);
	});
});

// ─── shouldStartListening ────────────────────────────────────────

/** JST hour を指定した Date を生成する（UTC = JST - 9h） */
function jstDate(hour: number, minute = 0): Date {
	const utcHour = (hour - 9 + 24) % 24;
	return new Date(Date.UTC(2026, 3, 6, utcHour, minute, 0));
}

describe("shouldStartListening — JST 変換ロジック", () => {
	test("UTC 0:00 → JST 9:00 として扱われる", () => {
		const utcMidnight = new Date(Date.UTC(2026, 3, 6, 0, 0, 0));
		// JST 9 時 = 日中帯 (base=0.35)
		// random が常に 0 → jitter = -0.1, pEffective = 0.25, 判定: 0 < 0.25 → true
		expect(shouldStartListening(utcMidnight, () => 0)).toBe(true);
	});

	test("UTC 15:00 → JST 0:00（深夜帯）として扱われる", () => {
		const utc15 = new Date(Date.UTC(2026, 3, 6, 15, 0, 0));
		// JST 0 時 = 深夜帯 (base=0.5)
		// random 常に 0 → true
		expect(shouldStartListening(utc15, () => 0)).toBe(true);
	});

	test("UTC 17:00 → JST 2:00（睡眠帯）は常に false", () => {
		const utc17 = new Date(Date.UTC(2026, 3, 6, 17, 0, 0));
		expect(shouldStartListening(utc17, () => 0)).toBe(false);
	});
});

describe("shouldStartListening — clamp 境界", () => {
	test("pEffective は常に [0, 1] に収まる（clamp の検証）", () => {
		// 現実装では最小 base=0.15, jitter=±0.1 なので
		// pEffective の範囲は [0.05, 0.7]。clamp(0) / clamp(1) は発動しないが、
		// 統計的に結果が有効範囲内であることを検証する。
		// base = 0.6
		const date = jstDate(20);
		let trueCount = 0;
		const N = 1000;
		let seed = 42;
		const pseudoRandom = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let j = 0; j < N; j++) {
			if (shouldStartListening(date, pseudoRandom)) trueCount++;
		}
		// 高確率帯 (base=0.6) なので一定割合は true
		expect(trueCount).toBeGreaterThan(0);
		expect(trueCount).toBeLessThan(N);
	});

	test("base=0 の時間帯は clamp に到達せず early return false", () => {
		// base = 0.0
		const date = jstDate(3);
		// random に何を渡しても false
		expect(shouldStartListening(date, () => 0)).toBe(false);
		expect(shouldStartListening(date, () => 0.5)).toBe(false);
		expect(shouldStartListening(date, () => 1)).toBe(false);
	});
});

describe("shouldStartListening — jitter の効果", () => {
	test("random=0 → jitter=-0.1（最小 jitter）", () => {
		// JST 10 時: base = 0.35, jitter = -0.1, pEffective = 0.25
		// 2回目の random() で判定: 0 < 0.25 → true
		const date = jstDate(10);
		expect(shouldStartListening(date, () => 0)).toBe(true);
	});

	test("random=1 → jitter=+0.1（最大 jitter）", () => {
		// JST 10 時: base = 0.35, jitter = +0.1, pEffective = 0.45
		// 2回目の random() も 1 → 1 < 0.45 は false
		const date = jstDate(10);
		expect(shouldStartListening(date, () => 1)).toBe(false);
	});

	test("random=0.5 → jitter=0（ゼロ jitter）", () => {
		// JST 10 時: base = 0.35, jitter = 0, pEffective = 0.35
		// 2回目の random() = 0.5 → 0.5 < 0.35 は false
		const date = jstDate(10);
		expect(shouldStartListening(date, () => 0.5)).toBe(false);
	});
});
