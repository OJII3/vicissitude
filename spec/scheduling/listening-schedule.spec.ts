import { describe, expect, test } from "bun:test";

import { shouldStartListening } from "@vicissitude/scheduling/listening-schedule";

/** JST hour を指定した Date を生成する（UTC = JST - 9h） */
function jstDate(hour: number): Date {
	const utcHour = (hour - 9 + 24) % 24;
	return new Date(Date.UTC(2026, 3, 6, utcHour, 0, 0));
}

describe("shouldStartListening — 公開 API 契約", () => {
	test("睡眠帯（JST 2:00-6:59）は false", () => {
		for (const h of [2, 3, 4, 5, 6]) {
			expect(shouldStartListening(jstDate(h))).toBe(false);
		}
	});

	test("活動帯（JST 7:00-翌1:59）は true", () => {
		for (const h of [0, 1, 7, 8, 12, 18, 23]) {
			expect(shouldStartListening(jstDate(h))).toBe(true);
		}
	});

	test("境界: JST 2:00 は false、JST 7:00 は true", () => {
		expect(shouldStartListening(jstDate(2))).toBe(false);
		expect(shouldStartListening(jstDate(7))).toBe(true);
	});

	test("引数に依存しない決定論的判定（同じ時刻なら同じ結果）", () => {
		const date = jstDate(15);
		expect(shouldStartListening(date)).toBe(shouldStartListening(date));
	});
});
