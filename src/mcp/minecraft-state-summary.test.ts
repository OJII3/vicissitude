import { describe, expect, test } from "bun:test";

import { formatEvents, summarizeState } from "./minecraft-state-summary.ts";
import type { BotEventInput, BotStateInput } from "./minecraft-state-summary.ts";

function makeState(overrides: Partial<BotStateInput> = {}): BotStateInput {
	return {
		position: { x: 120, y: 64, z: -200 },
		health: 20,
		food: 18,
		timePeriod: "夕",
		weather: "晴れ",
		action: { type: "idle" },
		nearbyEntities: [],
		inventory: { items: [], emptySlots: 36 },
		equipment: {},
		recentEvents: [],
		...overrides,
	};
}

describe("summarizeState", () => {
	test("基本的な状態要約を返す", () => {
		const result = summarizeState(makeState());
		expect(result).toContain("## 状態");
		expect(result).toContain("(120, 64, -200)");
		expect(result).toContain("♥♥♥♥♥♥♥♥♥♥ (20/20)");
		expect(result).toContain("🍖 18/20");
		expect(result).toContain("時間帯: 夕 | 天気: 晴れ");
		expect(result).toContain("行動: 待機中");
	});

	test("追従中のアクション状態", () => {
		const result = summarizeState(makeState({ action: { type: "following", target: "ojii3" } }));
		expect(result).toContain("行動: ojii3 を追従中");
	});

	test("周辺エンティティを表示する", () => {
		const result = summarizeState(
			makeState({
				nearbyEntities: [
					{ name: "ojii3", distance: 3, type: "player" },
					{ name: "zombie", distance: 12, type: "mob" },
				],
			}),
		);
		expect(result).toContain("## 周辺");
		expect(result).toContain("- ojii3 (プレイヤー, 3m)");
		expect(result).toContain("- zombie (mob, 12m) ⚠");
	});

	test("周辺にエンティティがない場合はセクションを省略", () => {
		const result = summarizeState(makeState({ nearbyEntities: [] }));
		expect(result).not.toContain("## 周辺");
	});

	test("インベントリを表示する", () => {
		const result = summarizeState(
			makeState({
				inventory: {
					items: [
						{ name: "Oak Log", count: 12 },
						{ name: "Cobblestone", count: 34 },
					],
					emptySlots: 24,
				},
			}),
		);
		expect(result).toContain("## インベントリ (24 空き)");
		expect(result).toContain("Oak Log x12, Cobblestone x34");
	});

	test("装備を表示する", () => {
		const result = summarizeState(
			makeState({
				equipment: { hand: "Diamond Pickaxe" },
			}),
		);
		expect(result).toContain("## 装備");
		expect(result).toContain("手: Diamond Pickaxe");
	});

	test("重要度 medium 以上のイベントのみ表示する", () => {
		const result = summarizeState(
			makeState({
				recentEvents: [
					{
						timestamp: "2026-03-09T18:03:00Z",
						kind: "playerJoined",
						description: "ojii3 が参加",
						importance: "medium",
					},
					{
						timestamp: "2026-03-09T18:04:00Z",
						kind: "health",
						description: "Health: 20, Food: 18",
						importance: "low",
					},
					{
						timestamp: "2026-03-09T18:05:00Z",
						kind: "death",
						description: "Bot died",
						importance: "high",
					},
				],
			}),
		);
		expect(result).toContain("## 直近イベント");
		expect(result).toContain("[18:03] ojii3 が参加");
		expect(result).not.toContain("Health: 20");
		expect(result).toContain("[18:05] Bot died");
	});

	test("重要イベントがない場合はセクションを省略", () => {
		const result = summarizeState(
			makeState({
				recentEvents: [
					{
						timestamp: "2026-03-09T18:04:00Z",
						kind: "health",
						description: "Health: 20, Food: 18",
						importance: "low",
					},
				],
			}),
		);
		expect(result).not.toContain("## 直近イベント");
	});
});

describe("formatEvents", () => {
	test("空のイベントリスト", () => {
		expect(formatEvents([])).toBe("イベントなし");
	});

	test("イベントをテキスト形式で返す", () => {
		const events: BotEventInput[] = [
			{
				timestamp: "2026-03-09T18:03:00Z",
				kind: "playerJoined",
				description: "ojii3 が参加",
				importance: "medium",
			},
			{
				timestamp: "2026-03-09T18:05:00Z",
				kind: "timeChange",
				description: "夜になった",
				importance: "low",
			},
		];
		const result = formatEvents(events);
		expect(result).toBe(
			"[2026-03-09T18:03:00Z] playerJoined: ojii3 が参加\n[2026-03-09T18:05:00Z] timeChange: 夜になった",
		);
	});
});
