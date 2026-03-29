import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { z } from "zod";

import { findPerceivedEntityByName } from "../bot-queries.ts";
import type { JobManager } from "../job-manager.ts";
import {
	type GetBot,
	ensureMovements,
	registerAbortHandler,
	textResult,
	tryStartJob,
} from "./shared.ts";

const { goals } = pathfinderPkg;

/** 武器の優先度リスト（上位ほど優先） */
const WEAPON_PRIORITY: string[] = [
	"netherite_sword",
	"diamond_sword",
	"iron_sword",
	"stone_sword",
	"wooden_sword",
	"netherite_axe",
	"diamond_axe",
	"iron_axe",
	"stone_axe",
	"wooden_axe",
];

/** 攻撃距離（ブロック） */
const ATTACK_RANGE = 3;

/** 攻撃クールダウン（ms） */
const ATTACK_COOLDOWN_MS = 600;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** インベントリから最適な武器を見つけて装備する */
async function equipBestWeapon(bot: mineflayer.Bot): Promise<string> {
	const inventory = bot.inventory.items();
	for (const weaponName of WEAPON_PRIORITY) {
		const item = inventory.find((i) => i.name === weaponName);
		if (item) {
			// oxlint-disable-next-line no-await-in-loop -- 最初に見つかった武器で即 return
			await bot.equip(item, "hand");
			return weaponName;
		}
	}
	return "素手";
}

/** エンティティ死亡/消滅を監視し、フラグオブジェクトで通知する */
function watchEntityGone(
	bot: mineflayer.Bot,
	target: Entity,
	signal: AbortSignal,
): { isDead: () => boolean; cleanup: () => void } {
	let dead = false;
	const cleanup = () => {
		bot.removeListener("entityDead", onGone);
		bot.removeListener("entityGone", onGone);
		dead = true;
	};
	const onGone = (e: { id: number }) => {
		if (e.id === target.id) cleanup();
	};
	bot.on("entityDead", onGone);
	bot.on("entityGone", onGone);
	signal.addEventListener("abort", cleanup, { once: true });
	return { isDead: () => dead, cleanup };
}

/** ターゲットに接近する。到達できなかった場合は false を返す */
async function approachTarget(
	bot: mineflayer.Bot,
	target: Entity,
	shouldStop: () => boolean,
): Promise<boolean> {
	try {
		await bot.pathfinder.goto(new goals.GoalFollow(target, ATTACK_RANGE - 1));
		return true;
	} catch {
		if (!shouldStop()) await sleep(ATTACK_COOLDOWN_MS);
		return false;
	}
}

interface AttackContext {
	bot: mineflayer.Bot;
	target: Entity;
	maxHits: number;
	signal: AbortSignal;
	watcher: { isDead: () => boolean };
	weapon: string;
	updateProgress: (progress: string) => void;
}

/** 攻撃ループ本体 */
async function attackLoop(ctx: AttackContext): Promise<void> {
	const { bot, target, maxHits, signal, watcher, weapon, updateProgress } = ctx;
	const shouldStop = () => watcher.isDead() || signal.aborted;
	let hits = 0;

	while (hits < maxHits && !shouldStop()) {
		if (bot.entity.position.distanceTo(target.position) > ATTACK_RANGE) {
			// oxlint-disable-next-line no-await-in-loop -- 接近は順次実行が必須
			const reached = await approachTarget(bot, target, shouldStop);
			if (!reached) continue;
		}

		if (shouldStop()) break;
		if (bot.entity.position.distanceTo(target.position) > ATTACK_RANGE) continue;

		try {
			bot.attack(target);
			hits++;
			updateProgress(`${String(hits)}/${String(maxHits)} 攻撃 (武器: ${weapon})`);
		} catch {
			// 攻撃失敗は無視して続行
		}

		if (hits < maxHits && !shouldStop()) {
			// oxlint-disable-next-line no-await-in-loop -- クールダウン待機
			await sleep(ATTACK_COOLDOWN_MS);
		}
	}
}

/** 攻撃ジョブの executor: 接近 → 攻撃を繰り返す */
async function executeAttack(
	bot: mineflayer.Bot,
	target: Entity,
	maxHits: number,
	signal: AbortSignal,
	updateProgress: (progress: string) => void,
): Promise<void> {
	ensureMovements(bot);
	registerAbortHandler(bot, signal);

	const weapon = await equipBestWeapon(bot);
	updateProgress(`武器: ${weapon}`);

	const watcher = watchEntityGone(bot, target, signal);
	try {
		await attackLoop({ bot, target, maxHits, signal, watcher, weapon, updateProgress });
	} finally {
		watcher.cleanup();
	}
}

export function registerAttackEntity(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	server.registerTool(
		"attack_entity",
		{
			description:
				"指定エンティティを攻撃する（非同期ジョブ: 即座に jobId を返す、最適武器自動装備）",
			inputSchema: {
				entityName: z
					.string()
					.min(1)
					.max(64)
					.describe('攻撃対象のエンティティ名（例: "zombie", "cow"）'),
				maxHits: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(20)
					.describe("最大攻撃回数（デフォルト: 20、安全弁）"),
			},
		},
		async ({ entityName, maxHits }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const target = await findPerceivedEntityByName(bot, entityName);
			if (!target) {
				return textResult(`"${entityName}" が近距離または視界内に見つかりません`);
			}

			const started = tryStartJob(jobManager, "attacking", entityName, (signal, updateProgress) =>
				executeAttack(bot, target, maxHits, signal, updateProgress),
			);
			if (!started.ok) return started.result;

			return textResult(
				`${entityName} への攻撃を開始しました（jobId: ${started.jobId}, 最大攻撃回数: ${String(maxHits)}）`,
			);
		},
	);
}
