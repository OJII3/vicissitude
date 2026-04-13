import { describe, expect, test } from "bun:test";

import { shouldStartListening } from "./listening-schedule.ts";

/** JST hour を指定した Date を生成する（UTC = JST - 9h） */
function jstDate(hour: number, minute = 0): Date {
	const utcHour = (hour - 9 + 24) % 24;
	return new Date(Date.UTC(2026, 3, 6, utcHour, minute, 0));
}

describe("shouldStartListening — 活動時間判定", () => {
	test("JST 7:00 → true（活動開始）", () => {
		expect(shouldStartListening(jstDate(7))).toBe(true);
	});

	test("JST 12:00 → true（日中）", () => {
		expect(shouldStartListening(jstDate(12))).toBe(true);
	});

	test("JST 20:00 → true（夜）", () => {
		expect(shouldStartListening(jstDate(20))).toBe(true);
	});

	test("JST 1:00 → true（深夜、睡眠帯の前）", () => {
		expect(shouldStartListening(jstDate(1))).toBe(true);
	});

	test("JST 1:59 → true（睡眠帯の直前）", () => {
		expect(shouldStartListening(jstDate(1, 59))).toBe(true);
	});

	test("JST 2:00 → false（睡眠帯開始）", () => {
		expect(shouldStartListening(jstDate(2))).toBe(false);
	});

	test("JST 4:00 → false（睡眠帯中間）", () => {
		expect(shouldStartListening(jstDate(4))).toBe(false);
	});

	test("JST 6:00 → false（睡眠帯）", () => {
		expect(shouldStartListening(jstDate(6))).toBe(false);
	});

	test("JST 6:59 → false（睡眠帯の直前終了）", () => {
		expect(shouldStartListening(jstDate(6, 59))).toBe(false);
	});

	test("全睡眠時間帯 (2-6) は false", () => {
		for (const h of [2, 3, 4, 5, 6]) {
			expect(shouldStartListening(jstDate(h))).toBe(false);
		}
	});

	test("全活動時間帯 (0-1, 7-23) は true", () => {
		for (const h of [0, 1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
			expect(shouldStartListening(jstDate(h))).toBe(true);
		}
	});
});
