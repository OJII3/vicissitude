/* oxlint-disable max-classes-per-file -- モック内の小クラス定義 */
import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// モジュールモック
//
// createFleeGoal は mineflayer-pathfinder の GoalInvert / GoalFollow を使う。
// 実クラスは描画/座標計算を要するため、構造を検証できるスタブに差し替える。
// reactive-layer.spec.ts と同一形式のモックを用いる。
// ---------------------------------------------------------------------------

void mock.module("mineflayer-pathfinder", () => ({
	default: {
		Movements: class {
			label = "movements";
		},
		goals: {
			GoalInvert: class {
				constructor(public goal: unknown) {}
			},
			GoalFollow: class {
				constructor(
					public entity: unknown,
					public distance: number,
				) {}
			},
		},
	},
}));

// モックが確定してから動的 import する
const { withConnectedBot, createFleeGoal, textResult } =
	await import("@vicissitude/minecraft/actions/shared");

// 接続済み bot を模した最小スタブ。`entity` を持つことが「接続済み」の条件。
function makeConnectedBot() {
	return { entity: { id: 1 } } as never;
}

describe("withConnectedBot", () => {
	test("getBot() が null のとき handler を呼ばず『ボット未接続』を返す", async () => {
		const handler = mock(() => textResult("呼ばれてはいけない"));
		const wrapped = withConnectedBot(() => null, handler);

		const result = await wrapped({});

		expect(result).toEqual(textResult("ボット未接続"));
		expect(handler).not.toHaveBeenCalled();
	});

	test("bot に entity が無いとき handler を呼ばず『ボット未接続』を返す", async () => {
		const handler = mock(() => textResult("呼ばれてはいけない"));
		const wrapped = withConnectedBot(() => ({}) as never, handler);

		const result = await wrapped({});

		expect(result).toEqual(textResult("ボット未接続"));
		expect(handler).not.toHaveBeenCalled();
	});

	test("接続済みのとき handler に接続済み bot を渡す", async () => {
		const bot = makeConnectedBot();
		const handler = mock((b: unknown) => textResult(`bot=${String(b === bot)}`));
		const wrapped = withConnectedBot(() => bot, handler);

		const result = await wrapped({});

		expect(result).toEqual(textResult("bot=true"));
	});

	test("接続済みのとき handler に呼び出し引数 args をそのまま渡す", async () => {
		const handler = mock((_b: unknown, args: { count: number }) =>
			textResult(`count=${String(args.count)}`),
		);
		const wrapped = withConnectedBot(makeConnectedBot, handler);

		const result = await wrapped({ count: 7 });

		expect(result).toEqual(textResult("count=7"));
	});

	test("handler が Promise を返す場合は解決値が返る", async () => {
		const wrapped = withConnectedBot(makeConnectedBot, () =>
			Promise.resolve(textResult("非同期成功")),
		);

		const result = await wrapped({});

		expect(result).toEqual(textResult("非同期成功"));
	});
});

describe("createFleeGoal", () => {
	test("GoalFollow を GoalInvert で反転したゴールを構築する", () => {
		const target = { id: 42 } as never;

		const goal = createFleeGoal(target, 32) as unknown as {
			goal: { entity: unknown; distance: number };
		};

		// 反転ゴールであること
		expect(goal).toHaveProperty("goal");
		// 内側の GoalFollow が target と distance を保持していること（挙動保存）
		expect(goal.goal.entity).toBe(target);
		expect(goal.goal.distance).toBe(32);
	});
});
