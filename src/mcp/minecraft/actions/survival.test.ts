import { describe, expect, test } from "bun:test";

import { listEdibleFoods } from "./survival.ts";

function makeBot(foodsByName: Record<string, { name: string; foodPoints: number; effectiveQuality: number; saturation: number }>) {
	return {
		registry: {
			foodsByName,
		},
	} as never;
}

describe("listEdibleFoods", () => {
	test("生の porkchop も食料候補に含む", () => {
		const bot = makeBot({
			porkchop: { name: "porkchop", foodPoints: 3, effectiveQuality: 4.8, saturation: 1.8 },
			bread: { name: "bread", foodPoints: 5, effectiveQuality: 11, saturation: 6 },
		});
		const foods = listEdibleFoods(bot, false).map((food) => food.name);
		expect(foods).toContain("porkchop");
	});

	test("emergency=false では golden apple 系を除外する", () => {
		const bot = makeBot({
			golden_apple: {
				name: "golden_apple",
				foodPoints: 4,
				effectiveQuality: 13.6,
				saturation: 9.6,
			},
			bread: { name: "bread", foodPoints: 5, effectiveQuality: 11, saturation: 6 },
		});
		const foods = listEdibleFoods(bot, false).map((food) => food.name);
		expect(foods).toEqual(["bread"]);
	});

	test("effectiveQuality の高い順に優先する", () => {
		const bot = makeBot({
			porkchop: { name: "porkchop", foodPoints: 3, effectiveQuality: 4.8, saturation: 1.8 },
			cooked_porkchop: {
				name: "cooked_porkchop",
				foodPoints: 8,
				effectiveQuality: 20.8,
				saturation: 12.8,
			},
			bread: { name: "bread", foodPoints: 5, effectiveQuality: 11, saturation: 6 },
		});
		const foods = listEdibleFoods(bot, false).map((food) => food.name);
		expect(foods).toEqual(["cooked_porkchop", "bread", "porkchop"]);
	});

	test("通常時は有害 food を除外する", () => {
		const bot = makeBot({
			rotten_flesh: {
				name: "rotten_flesh",
				foodPoints: 4,
				effectiveQuality: 6.4,
				saturation: 2.4,
			},
			bread: { name: "bread", foodPoints: 5, effectiveQuality: 11, saturation: 6 },
		});
		const foods = listEdibleFoods(bot, false).map((food) => food.name);
		expect(foods).toEqual(["bread"]);
	});

	test("緊急時は有害 food も候補に戻す", () => {
		const bot = makeBot({
			rotten_flesh: {
				name: "rotten_flesh",
				foodPoints: 4,
				effectiveQuality: 6.4,
				saturation: 2.4,
			},
		});
		const foods = listEdibleFoods(bot, true).map((food) => food.name);
		expect(foods).toEqual(["rotten_flesh"]);
	});
});
