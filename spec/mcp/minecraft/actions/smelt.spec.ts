import { describe, expect, test } from "bun:test";

import { registerSmeltItem } from "@vicissitude/minecraft/actions/jobs";

type ToolHandler = (args: { itemName: string; count: number; fuelName: string }) => unknown;

function captureSmeltHandler(getBot: () => unknown): ToolHandler {
	const result: { handler: ToolHandler | null } = { handler: null };
	const fakeServer = {
		tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
			result.handler = handler;
		},
	};
	const fakeJobManager = {
		startJob: (_type: string, _target: string, _executor: unknown) => "job-1",
	};
	registerSmeltItem(fakeServer as never, getBot as never, fakeJobManager as never);
	if (!result.handler) throw new Error("handler not captured");
	return result.handler;
}

function textOf(result: unknown): string {
	const r = result as { content: { type: string; text: string }[] };
	return r.content[0]?.text ?? "";
}

function makeBot(
	overrides: {
		itemsByName?: Record<string, { id: number }>;
		inventoryItems?: { name: string; count: number }[];
	} = {},
) {
	return {
		entity: {},
		registry: {
			itemsByName: overrides.itemsByName ?? {
				raw_iron: { id: 1 },
				coal: { id: 2 },
			},
		},
		inventory: {
			items: () =>
				overrides.inventoryItems ?? [
					{ name: "raw_iron", count: 10 },
					{ name: "coal", count: 8 },
				],
		},
		pathfinder: { movements: null, setMovements: () => {}, stop: () => {} },
	};
}

describe("smelt_item", () => {
	test("ボット未接続時に「ボット未接続」を返す", () => {
		const handler = captureSmeltHandler(() => null);
		const result = handler({ itemName: "raw_iron", count: 1, fuelName: "coal" });
		expect(textOf(result)).toBe("ボット未接続");
	});

	test("不明なアイテム名でエラーメッセージを返す", () => {
		const bot = makeBot();
		const handler = captureSmeltHandler(() => bot);
		const result = handler({ itemName: "unknown_item", count: 1, fuelName: "coal" });
		expect(textOf(result)).toBe('不明なアイテム名: "unknown_item"');
	});

	test("不明な燃料名でエラーメッセージを返す", () => {
		const bot = makeBot();
		const handler = captureSmeltHandler(() => bot);
		const result = handler({ itemName: "raw_iron", count: 1, fuelName: "unknown_fuel" });
		expect(textOf(result)).toBe('不明な燃料名: "unknown_fuel"');
	});

	test("インベントリにアイテムがない場合エラーメッセージを返す", () => {
		const bot = makeBot({ inventoryItems: [{ name: "coal", count: 8 }] });
		const handler = captureSmeltHandler(() => bot);
		const result = handler({ itemName: "raw_iron", count: 1, fuelName: "coal" });
		expect(textOf(result)).toBe('インベントリに "raw_iron" がありません');
	});

	test("正常時にジョブ開始メッセージを返す", () => {
		const bot = makeBot();
		const handler = captureSmeltHandler(() => bot);
		const result = handler({ itemName: "raw_iron", count: 3, fuelName: "coal" });
		expect(textOf(result)).toContain("raw_iron の精錬を開始しました");
		expect(textOf(result)).toContain("job-1");
		expect(textOf(result)).toContain("3 個");
		expect(textOf(result)).toContain("coal");
	});
});
