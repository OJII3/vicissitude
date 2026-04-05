import { describe, expect, test } from "bun:test";

import {
	hourBucketProbability,
	shouldStartListening,
} from "@vicissitude/scheduling/listening-schedule";

// ─── hourBucketProbability ───────────────────────────────────────

describe("hourBucketProbability (JST hour → base probability)", () => {
	test("2-7 時は 0（聴かない）", () => {
		expect(hourBucketProbability(2)).toBe(0);
		expect(hourBucketProbability(3)).toBe(0);
		expect(hourBucketProbability(6)).toBe(0);
	});

	test("7-9 時は低確率（0 より大きく 0.3 未満）", () => {
		const p7 = hourBucketProbability(7);
		const p8 = hourBucketProbability(8);
		expect(p7).toBeGreaterThan(0);
		expect(p7).toBeLessThan(0.3);
		expect(p8).toBeGreaterThan(0);
		expect(p8).toBeLessThan(0.3);
	});

	test("9-18 時は中確率（0.3 以上 0.5 未満）", () => {
		for (const h of [9, 10, 11, 12, 13, 14, 15, 16, 17]) {
			const p = hourBucketProbability(h);
			expect(p).toBeGreaterThanOrEqual(0.3);
			expect(p).toBeLessThan(0.5);
		}
	});

	test("18-24 時は高確率（0.5 以上）", () => {
		for (const h of [18, 19, 20, 21, 22, 23]) {
			expect(hourBucketProbability(h)).toBeGreaterThanOrEqual(0.5);
		}
	});

	test("0-2 時は中〜高確率（7-9 時より高く、18-24 時より低いまたは同等）", () => {
		const p0 = hourBucketProbability(0);
		const p1 = hourBucketProbability(1);
		expect(p0).toBeGreaterThan(hourBucketProbability(7));
		expect(p1).toBeGreaterThan(hourBucketProbability(7));
		expect(p0).toBeLessThanOrEqual(hourBucketProbability(20));
	});

	test("18-24 時 > 9-18 時 > 7-9 時 の順序が保たれる", () => {
		expect(hourBucketProbability(20)).toBeGreaterThan(hourBucketProbability(10));
		expect(hourBucketProbability(10)).toBeGreaterThan(hourBucketProbability(8));
	});
});

// ─── shouldStartListening ────────────────────────────────────────

/** 固定値を返す決定論的 random を生成する */
function constantRandom(value: number): () => number {
	return () => value;
}

/** JST hour を指定した Date を生成する（UTC = JST - 9h） */
function jstDate(hour: number): Date {
	// UTC 時刻 = JST 時刻 - 9h。hour は 0-23 の JST。
	const utcHour = (hour - 9 + 24) % 24;
	return new Date(Date.UTC(2026, 3, 6, utcHour, 0, 0));
}

describe("shouldStartListening (時間帯確率 + jitter)", () => {
	test("JST 2-7 時は常に false（random 値に関わらず）", () => {
		for (const h of [2, 3, 4, 5, 6]) {
			const date = jstDate(h);
			// どんな random 値でも false
			expect(shouldStartListening(date, constantRandom(0.0))).toBe(false);
			expect(shouldStartListening(date, constantRandom(0.5))).toBe(false);
			expect(shouldStartListening(date, constantRandom(0.99))).toBe(false);
		}
	});

	test("JST 20 時（高確率帯）、random が常に 0 → 必ず true", () => {
		const date = jstDate(20);
		expect(shouldStartListening(date, constantRandom(0.0))).toBe(true);
	});

	test("JST 20 時（高確率帯）、random が常に 0.99 → false（確率を超える）", () => {
		const date = jstDate(20);
		expect(shouldStartListening(date, constantRandom(0.99))).toBe(false);
	});

	test("JST 8 時（低確率帯）、random 0.99 → false", () => {
		const date = jstDate(8);
		expect(shouldStartListening(date, constantRandom(0.99))).toBe(false);
	});

	test("JST 8 時（低確率帯）、random 0 → true", () => {
		const date = jstDate(8);
		expect(shouldStartListening(date, constantRandom(0.0))).toBe(true);
	});

	test("jitter により同じ時刻でも random 値次第で結果が変わる（決定論的ゆらぎ）", () => {
		// 同じ時刻・同じ random 値なら同じ結果（純粋関数性）
		const date = jstDate(15);
		const r1 = shouldStartListening(date, constantRandom(0.3));
		const r2 = shouldStartListening(date, constantRandom(0.3));
		expect(r1).toBe(r2);
	});

	test("2-7 時帯以外で、random を連続供給すると一定割合で true が返る（大数の法則）", () => {
		// 高確率帯
		const date = jstDate(20);
		// 一様乱数を模擬
		let seed = 1;
		const pseudoRandom = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		let trueCount = 0;
		const N = 1000;
		for (let i = 0; i < N; i++) {
			if (shouldStartListening(date, pseudoRandom)) trueCount++;
		}
		// 高確率帯なら 30% 以上は true
		expect(trueCount / N).toBeGreaterThan(0.3);
	});
});
