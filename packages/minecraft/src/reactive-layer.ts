import type mineflayer from "mineflayer";
import pathfinderModule from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";

import { listEdibleFoods } from "./actions/survival/food.ts";
import type { BotContext } from "./bot-context.ts";
import { isHostileMob } from "./helpers.ts";

const { goals } = pathfinderModule;
const { GoalInvert, GoalFollow } = goals;

/** クリーパー/ウォーデンの逃走距離閾値 */
const EXTENDED_FLEE_DISTANCE = 16;
/** その他 hostile mob の逃走距離閾値 */
const DEFAULT_FLEE_DISTANCE = 8;
/** 拡張距離が適用される mob */
const EXTENDED_DISTANCE_MOBS = new Set(["creeper", "warden"]);

export interface ReactiveLayerOptions {
	/** hostile mob スキャンの最小間隔（ms）。デフォルト: 1000 */
	scanIntervalMs?: number;
	/** Brain のジョブをキャンセルするコールバック */
	onCancelJob?: () => void;
}

export class ReactiveLayer {
	private readonly ctx: BotContext;
	private readonly scanIntervalMs: number;
	private readonly onCancelJob?: () => void;
	private attached = false;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private lastScanTime = 0;
	private lastNoFoodEventTime = 0;
	private respawning = false;
	private spawnListener: (() => void) | null = null;

	constructor(ctx: BotContext, options?: ReactiveLayerOptions) {
		this.ctx = ctx;
		this.scanIntervalMs = options?.scanIntervalMs ?? 1000;
		this.onCancelJob = options?.onCancelJob;
	}

	attach(): void {
		if (this.attached) return;
		this.attached = true;
		this.intervalId = setInterval(() => {
			void this.tick();
		}, 250);
	}

	detach(): void {
		if (!this.attached) return;
		this.attached = false;
		if (this.intervalId !== null) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.removeSpawnListener();
		this.respawning = false;
	}

	isAttached(): boolean {
		return this.attached;
	}

	/** 1回の反射チェックを実行する（テスト用に公開） */
	async tick(): Promise<void> {
		const bot = this.ctx.getBot();
		if (bot === null) return;

		// 優先度1: リスポーン（ActionState に関係なく常に実行）
		if (bot.health <= 0) {
			this.handleRespawn(bot);
			return;
		}

		// 優先度2: 逃走（スロットリング付き）
		const now = Date.now();
		if (now - this.lastScanTime >= this.scanIntervalMs) {
			this.lastScanTime = now;
			const nearestHostile = this.findNearestHostile(bot);
			if (nearestHostile !== null) {
				await this.handleFlee(bot, nearestHostile);
				return;
			}
		}

		// 優先度3: 自動食事
		if (bot.health <= 6 || bot.food <= 6) {
			await this.handleEat(bot);
		}
	}

	private handleRespawn(bot: mineflayer.Bot): void {
		if (this.respawning) return;
		this.respawning = true;

		try {
			bot.respawn();
			this.registerSpawnListener(bot);
			this.ctx.pushEvent("reactive_respawn", "死亡後にリスポーンをリクエストしました", "critical");
		} catch {
			this.respawning = false;
			this.ctx.pushEvent("reactive_respawn_failed", "リスポーンに失敗しました", "critical");
		}
	}

	private registerSpawnListener(bot: mineflayer.Bot): void {
		this.removeSpawnListener();
		this.spawnListener = () => {
			this.respawning = false;
		};
		bot.once("spawn", this.spawnListener);
	}

	private removeSpawnListener(): void {
		if (this.spawnListener !== null) {
			const bot = this.ctx.getBot();
			if (bot !== null) {
				bot.removeListener("spawn", this.spawnListener);
			}
			this.spawnListener = null;
		}
	}

	private findNearestHostile(bot: mineflayer.Bot): {
		entity: { position: { distanceTo: (pos: unknown) => number }; name?: string };
		distance: number;
	} | null {
		const botPos = bot.entity.position;
		let nearest: {
			entity: { position: { distanceTo: (pos: unknown) => number }; name?: string };
			distance: number;
		} | null = null;

		for (const entity of Object.values(bot.entities)) {
			const e = entity as {
				name?: string;
				type?: string;
				position?: { distanceTo: (pos: unknown) => number };
			};
			if (
				e.name === undefined ||
				e.name === null ||
				!isHostileMob(e.name) ||
				e.position === undefined ||
				e.position === null
			)
				continue;

			const distance = e.position.distanceTo(botPos);
			const threshold = EXTENDED_DISTANCE_MOBS.has(e.name.toLowerCase())
				? EXTENDED_FLEE_DISTANCE
				: DEFAULT_FLEE_DISTANCE;

			if (distance <= threshold && (nearest === null || distance < nearest.distance)) {
				nearest = {
					entity: e as { position: { distanceTo: (pos: unknown) => number }; name?: string },
					distance,
				};
			}
		}

		return nearest;
	}

	private cancelJobIfNeeded(): void {
		if (this.ctx.getActionState().type !== "idle") {
			this.onCancelJob?.();
			this.ctx.setActionState({ type: "idle" });
		}
	}

	private async handleFlee(
		bot: mineflayer.Bot,
		hostile: {
			entity: { position: { distanceTo: (pos: unknown) => number }; name?: string };
			distance: number;
		},
	): Promise<void> {
		this.cancelJobIfNeeded();
		this.ctx.setActionState({ type: "fleeing", target: hostile.entity.name });

		try {
			const goal = new GoalInvert(new GoalFollow(hostile.entity as unknown as Entity, 1));
			await bot.pathfinder.goto(goal);
			this.ctx.pushEvent(
				"reactive_flee",
				`${hostile.entity.name ?? "hostile mob"} から逃走しました（距離: ${String(Math.round(hostile.distance))}）`,
				"high",
			);
		} catch {
			this.ctx.pushEvent(
				"reactive_flee_failed",
				`${hostile.entity.name ?? "hostile mob"} からの逃走に失敗しました`,
				"high",
			);
		} finally {
			this.ctx.setActionState({ type: "idle" });
		}
	}

	private async handleEat(bot: mineflayer.Bot): Promise<void> {
		const emergency = bot.health <= 6;
		const edibleFoods = listEdibleFoods(bot, emergency);
		const inventory = bot.inventory.items();

		for (const food of edibleFoods) {
			const item = inventory.find((i) => i.name === food.name);
			if (item === undefined) continue;

			this.cancelJobIfNeeded();
			this.ctx.setActionState({ type: "eating", target: food.name });

			try {
				// oxlint-disable-next-line no-await-in-loop -- 最初にマッチした食料を1つ食べて即 return する
				await bot.equip(item, "hand");
				// oxlint-disable-next-line no-await-in-loop -- 同上
				await bot.consume();
				this.ctx.pushEvent("reactive_eat", `${food.name} を自動で食べました`, "high");
			} catch {
				this.ctx.pushEvent(
					"reactive_eat_failed",
					`${food.name} を食べようとしましたが中断されました`,
					"high",
				);
			} finally {
				this.ctx.setActionState({ type: "idle" });
			}
			return;
		}

		// 食料がない（スロットリング: scanIntervalMs 以内に重複発火しない）
		const now = Date.now();
		if (now - this.lastNoFoodEventTime >= this.scanIntervalMs) {
			this.lastNoFoodEventTime = now;
			this.ctx.pushEvent("reactive_no_food", "食料がインベントリにありません", "high");
		}
	}
}
