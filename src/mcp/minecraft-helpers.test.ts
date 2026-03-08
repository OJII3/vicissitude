import { describe, expect, test } from "bun:test";

import { getTimePeriod } from "./minecraft-helpers.ts";

describe("getTimePeriod", () => {
	test("0 → 朝", () => expect(getTimePeriod(0)).toBe("朝"));
	test("5999 → 朝", () => expect(getTimePeriod(5999)).toBe("朝"));
	test("6000 → 昼", () => expect(getTimePeriod(6000)).toBe("昼"));
	test("11999 → 昼", () => expect(getTimePeriod(11999)).toBe("昼"));
	test("12000 → 夕", () => expect(getTimePeriod(12000)).toBe("夕"));
	test("12999 → 夕", () => expect(getTimePeriod(12999)).toBe("夕"));
	test("13000 → 夜", () => expect(getTimePeriod(13000)).toBe("夜"));
	test("23999 → 夜", () => expect(getTimePeriod(23999)).toBe("夜"));
});
