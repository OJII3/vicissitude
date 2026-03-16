import { describe, expect, test } from "bun:test";

import {
	formatActionState,
	formatEntityEntry,
	formatEquipmentText,
	formatHealthBar,
	formatInventoryText,
	getTimePeriod,
	isHostileMob,
} from "../../../packages/minecraft/src/helpers.ts";

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

describe("isHostileMob", () => {
	test("zombie は hostile", () => expect(isHostileMob("zombie")).toBe(true));
	test("Skeleton は hostile（大文字小文字無視）", () =>
		expect(isHostileMob("Skeleton")).toBe(true));
	test("cow は hostile でない", () => expect(isHostileMob("cow")).toBe(false));
	test("creeper は hostile", () => expect(isHostileMob("creeper")).toBe(true));
});

describe("formatHealthBar", () => {
	test("満タン (20)", () => expect(formatHealthBar(20)).toBe("♥♥♥♥♥♥♥♥♥♥ (20/20)"));
	test("半分 (10)", () => expect(formatHealthBar(10)).toBe("♥♥♥♥♥♡♡♡♡♡ (10/20)"));
	test("瀕死 (1)", () => expect(formatHealthBar(1)).toBe("♥♡♡♡♡♡♡♡♡♡ (1/20)"));
	test("ゼロ (0)", () => expect(formatHealthBar(0)).toBe("♡♡♡♡♡♡♡♡♡♡ (0/20)"));
});

describe("formatInventoryText", () => {
	test("空インベントリ", () => expect(formatInventoryText([], 36)).toBe("空"));
	test("アイテムあり", () => {
		const items = [
			{ name: "Oak Log", count: 12 },
			{ name: "Diamond Pickaxe", count: 1 },
		];
		expect(formatInventoryText(items, 34)).toBe("Oak Log x12, Diamond Pickaxe");
	});
});

describe("formatEquipmentText", () => {
	test("装備なし", () => expect(formatEquipmentText({})).toBe("なし"));
	test("手のみ", () =>
		expect(formatEquipmentText({ hand: "Diamond Sword" })).toBe("手: Diamond Sword"));
	test("複数装備", () => {
		expect(formatEquipmentText({ hand: "Diamond Sword", head: "Iron Helmet" })).toBe(
			"手: Diamond Sword, 頭: Iron Helmet",
		);
	});
});

describe("formatEntityEntry", () => {
	test("プレイヤー", () => {
		expect(formatEntityEntry({ name: "ojii3", distance: 5, type: "player" })).toBe(
			"- ojii3 (プレイヤー, 5m)",
		);
	});
	test("hostile mob に ⚠ が付く", () => {
		expect(formatEntityEntry({ name: "zombie", distance: 12, type: "mob" })).toBe(
			"- zombie (mob, 12m) ⚠",
		);
	});
	test("passive mob に ⚠ は付かない", () => {
		expect(formatEntityEntry({ name: "cow", distance: 8, type: "mob" })).toBe("- cow (mob, 8m)");
	});
});

describe("formatActionState", () => {
	test("idle", () => expect(formatActionState({ type: "idle" })).toBe("待機中"));
	test("following", () =>
		expect(formatActionState({ type: "following", target: "ojii3" })).toBe("ojii3 を追従中"));
	test("moving", () =>
		expect(formatActionState({ type: "moving", target: "(10, 64, -20)" })).toBe(
			"(10, 64, -20) へ移動中",
		));
	test("collecting", () =>
		expect(formatActionState({ type: "collecting", target: "oak_log" })).toBe("oak_log を採集中"));
	test("collecting with progress", () =>
		expect(
			formatActionState({ type: "collecting", target: "oak_log", progress: "3/10 採集済み" }),
		).toBe("oak_log を採集中 (3/10 採集済み)"));
	test("moving with progress", () =>
		expect(
			formatActionState({ type: "moving", target: "(10, 64, -20)", progress: "移動中..." }),
		).toBe("(10, 64, -20) へ移動中 (移動中...)"));
	test("crafting", () =>
		expect(formatActionState({ type: "crafting", target: "stick" })).toBe("stick をクラフト中"));
	test("crafting with progress", () =>
		expect(
			formatActionState({ type: "crafting", target: "stick", progress: "クラフト中..." }),
		).toBe("stick をクラフト中 (クラフト中...)"));
	test("sleeping", () =>
		expect(formatActionState({ type: "sleeping", target: "ベッド" })).toBe("ベッド で就寝中"));
	test("fleeing", () =>
		expect(formatActionState({ type: "fleeing", target: "creeper" })).toBe("creeper から逃走中"));
	test("fleeing with progress", () =>
		expect(
			formatActionState({ type: "fleeing", target: "creeper", progress: "32ブロック逃走中" }),
		).toBe("creeper から逃走中 (32ブロック逃走中)"));
	test("sheltering", () =>
		expect(formatActionState({ type: "sheltering", target: "避難場所" })).toBe(
			"避難場所 へ避難中",
		));
	test("sheltering with progress", () =>
		expect(
			formatActionState({
				type: "sheltering",
				target: "避難場所",
				progress: "緊急シェルター構築中",
			}),
		).toBe("避難場所 へ避難中 (緊急シェルター構築中)"));
	test("attacking", () =>
		expect(formatActionState({ type: "attacking", target: "zombie" })).toBe("zombie を攻撃中"));
	test("attacking with progress", () =>
		expect(
			formatActionState({
				type: "attacking",
				target: "zombie",
				progress: "3/20 攻撃 (武器: iron_sword)",
			}),
		).toBe("zombie を攻撃中 (3/20 攻撃 (武器: iron_sword))"));
});
