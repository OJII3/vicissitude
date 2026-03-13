import { describe, expect, test } from "bun:test";
import { type BridgeEvent, parseBridgeEvent } from "../../store/mc-bridge.ts";
import { formatStatusEvents } from "./mc-bridge-shared.ts";

function makeEvent(overrides: Partial<BridgeEvent> & { payload: string }): BridgeEvent {
	return {
		id: 1,
		direction: "to_discord",
		type: "report",
		createdAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
		...overrides,
	};
}

describe("parseBridgeEvent", () => {
	test("parses valid report JSON with all fields", () => {
		const e = makeEvent({
			payload: JSON.stringify({ message: "ダイヤ発見", importance: "high", category: "discovery" }),
		});
		const result = parseBridgeEvent(e);
		expect(result.message).toBe("ダイヤ発見");
		expect(result.importance).toBe("high");
		expect(result.category).toBe("discovery");
	});

	test("defaults importance to medium and category to status", () => {
		const e = makeEvent({
			payload: JSON.stringify({ message: "一般報告" }),
		});
		const result = parseBridgeEvent(e);
		expect(result.importance).toBe("medium");
		expect(result.category).toBe("status");
	});

	test("falls back for malformed JSON", () => {
		const e = makeEvent({ payload: "not json" });
		const result = parseBridgeEvent(e);
		expect(result.message).toBe("(report) not json");
		expect(result.category).toBe("status");
	});

	test("falls back for non-report event types", () => {
		const e = makeEvent({ type: "command", payload: "dig diamond" });
		const result = parseBridgeEvent(e);
		expect(result.message).toBe("(command) dig diamond");
		expect(result.importance).toBe("low");
	});
});

describe("formatStatusEvents", () => {
	test("groups danger reports first", () => {
		const events: BridgeEvent[] = [
			makeEvent({
				payload: JSON.stringify({ message: "クリーパー接近", importance: "high", category: "danger" }),
			}),
			makeEvent({
				payload: JSON.stringify({ message: "採掘完了", importance: "medium", category: "completion" }),
			}),
		];

		const output = formatStatusEvents(events);
		const dangerIdx = output.indexOf("⚠ 危険/緊急:");
		const restIdx = output.indexOf("直近の出来事:");
		expect(dangerIdx).toBeGreaterThanOrEqual(0);
		expect(restIdx).toBeGreaterThan(dangerIdx);
		expect(output).toContain("[high] クリーパー接近");
		expect(output).toContain("[completion] 採掘完了");
	});

	test("groups stuck reports separately", () => {
		const events: BridgeEvent[] = [
			makeEvent({
				payload: JSON.stringify({ message: "パスが通らない", importance: "medium", category: "stuck" }),
			}),
		];

		const output = formatStatusEvents(events);
		expect(output).toContain("🔄 行き詰まり:");
		expect(output).toContain("パスが通らない");
	});

	test("omits tag for status category", () => {
		const events: BridgeEvent[] = [
			makeEvent({
				payload: JSON.stringify({ message: "一般報告", importance: "low" }),
			}),
		];

		const output = formatStatusEvents(events);
		expect(output).toContain("一般報告");
		expect(output).not.toContain("[status]");
	});

	test("returns empty string for empty events", () => {
		expect(formatStatusEvents([])).toBe("");
	});
});
