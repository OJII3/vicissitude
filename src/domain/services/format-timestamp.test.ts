import { describe, expect, it } from "bun:test";

import { formatTime, formatTimestamp } from "./format-timestamp.ts";

describe("formatTimestamp", () => {
	it("UTC を JST (UTC+9) に変換して YYYY-MM-DD HH:mm 形式で返す", () => {
		const date = new Date("2026-03-01T06:30:00Z");
		expect(formatTimestamp(date)).toBe("2026-03-01 15:30");
	});

	it("日付またぎ: UTC 15:00 → JST 翌日 00:00", () => {
		const date = new Date("2026-03-01T15:00:00Z");
		expect(formatTimestamp(date)).toBe("2026-03-02 00:00");
	});

	it("月またぎ: UTC 1月31日 23:00 → JST 2月1日 08:00", () => {
		const date = new Date("2026-01-31T23:00:00Z");
		expect(formatTimestamp(date)).toBe("2026-02-01 08:00");
	});

	it("年またぎ: UTC 12月31日 15:00 → JST 1月1日 00:00", () => {
		const date = new Date("2025-12-31T15:00:00Z");
		expect(formatTimestamp(date)).toBe("2026-01-01 00:00");
	});

	it("1桁の月・日・時・分はゼロ埋めされる", () => {
		const date = new Date("2026-01-02T00:05:00Z");
		expect(formatTimestamp(date)).toBe("2026-01-02 09:05");
	});

	it("UTC 0時ちょうど → JST 09:00", () => {
		const date = new Date("2026-06-15T00:00:00Z");
		expect(formatTimestamp(date)).toBe("2026-06-15 09:00");
	});
});

describe("formatTime", () => {
	it("HH:mm 形式で JST 時刻を返す", () => {
		const date = new Date("2026-03-01T06:30:00Z");
		expect(formatTime(date)).toBe("15:30");
	});

	it("日付またぎでも時刻部分のみ返す", () => {
		const date = new Date("2026-03-01T15:00:00Z");
		expect(formatTime(date)).toBe("00:00");
	});

	it("1桁の時・分はゼロ埋めされる", () => {
		const date = new Date("2026-01-01T00:05:00Z");
		expect(formatTime(date)).toBe("09:05");
	});
});
