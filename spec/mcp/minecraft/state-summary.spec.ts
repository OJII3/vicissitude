import { describe, expect, test } from "bun:test";

import type { JobInfo } from "../../../src/mcp/minecraft/helpers.ts";
import {
	formatEvents,
	formatJobStatus,
	summarizeState,
} from "../../../src/mcp/minecraft/state-summary.ts";
import type { BotEventInput, BotStateInput } from "../../../src/mcp/minecraft/state-summary.ts";

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

	test("stuckWarning 設定時にスタック警告セクションが出力される", () => {
		const result = summarizeState(
			makeState({ stuckWarning: "直近 4 件のジョブがすべて失敗。最後の成功から 10 分経過" }),
		);
		expect(result).toContain("## スタック警告");
		expect(result).toContain("直近 4 件のジョブがすべて失敗");
	});

	test("stuckWarning 未設定時はスタック警告セクションが省略される", () => {
		const result = summarizeState(makeState());
		expect(result).not.toContain("## スタック警告");
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

function makeJob(overrides: Partial<JobInfo> = {}): JobInfo {
	return {
		id: "job-1",
		type: "moving",
		target: "(10, 64, -20)",
		status: "running",
		startedAt: new Date("2026-03-09T18:00:00Z"),
		...overrides,
	};
}

describe("formatJobStatus", () => {
	test("現在のジョブがない場合", () => {
		const result = formatJobStatus(null, []);
		expect(result).toContain("## 現在のジョブ");
		expect(result).toContain("なし");
		expect(result).not.toContain("## ジョブ履歴");
	});

	test("現在のジョブがある場合", () => {
		const current = makeJob();
		const result = formatJobStatus(current, []);
		expect(result).toContain("実行中: moving → (10, 64, -20)");
	});

	test("ジョブ履歴を表示する", () => {
		const recent = [
			makeJob({
				id: "job-1",
				status: "completed",
				target: "A",
				finishedAt: new Date("2026-03-09T18:01:00Z"),
			}),
			makeJob({
				id: "job-2",
				status: "failed",
				target: "B",
				error: "パスなし",
				finishedAt: new Date("2026-03-09T18:02:00Z"),
			}),
		];
		const result = formatJobStatus(null, recent);
		expect(result).toContain("## ジョブ履歴");
		expect(result).toContain("完了: moving → A");
		expect(result).toContain("失敗: moving → B (パスなし)");
	});

	test("キャンセル済みジョブの表示", () => {
		const recent = [makeJob({ status: "cancelled", target: "C" })];
		const result = formatJobStatus(null, recent);
		expect(result).toContain("キャンセル: moving → C");
	});

	test("クールダウン中ジョブを表示する", () => {
		const result = formatJobStatus(
			null,
			[],
			[{ type: "moving", until: new Date("2026-03-09T18:03:00Z") }],
		);
		expect(result).toContain("## クールダウン");
		expect(result).toContain("moving: 18:03:00 まで停止");
	});
});
