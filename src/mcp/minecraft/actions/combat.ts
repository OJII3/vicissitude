import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { z } from "zod";

import type { JobManager } from "../job-manager.ts";
import { type GetBot, ensureMovements, registerAbortHandler, textResult } from "./shared.ts";

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
): { isDead: () => boolean } {
	let dead = false;
	const onGone = (e: { id: number }) => {
		if (e.id === target.id) {
			bot.removeListener("entityDead", onGone);
			bot.removeListener("entityGone", onGone);
			dead = true;
		}
	};
	bot.on("entityDead", onGone);
	bot.on("entityGone", onGone);
	signal.addEventListener(
		"abort",
		() => {
			bot.removeListener("entityDead", onGone);
			bot.removeListener("entityGone", onGone);
			dead = true;
		},
		{ once: true },
	);
	return { isDead: () => dead };
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
	let hits = 0;

	while (hits < maxHits && !signal.aborted && !watcher.isDead()) {
		const dist = bot.entity.position.distanceTo(target.position);
		if (dist > ATTACK_RANGE) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- 接近は順次実行が必須
				await bot.pathfinder.goto(new goals.GoalFollow(target, ATTACK_RANGE - 1));
			} catch {
				if (!watcher.isDead() && !signal.aborted) {
					// oxlint-disable-next-line no-await-in-loop -- リトライ待機
					await sleep(ATTACK_COOLDOWN_MS);
					continue;
				}
				break;
			}
		}

		if (signal.aborted || watcher.isDead()) break;

		try {
			// oxlint-disable-next-line no-await-in-loop -- 攻撃は順次実行が必須
			await bot.attack(target);
			hits++;
			updateProgress(`${String(hits)}/${String(maxHits)} 攻撃 (武器: ${weapon})`);
		} catch {
			// 攻撃失敗は無視して続行
		}

		if (hits < maxHits && !signal.aborted && !watcher.isDead()) {
			// oxlint-disable-next-line no-await-in-loop -- クールダウン待機
			await sleep(ATTACK_COOLDOWN_MS);
		}
	}
}

export function registerAttackEntity(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	server.tool(
		"attack_entity",
		"指定エンティティを攻撃する（非同期ジョブ: 即座に jobId を返す、最適武器自動装備）",
		{
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
		({ entityName, maxHits }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const lowerName = entityName.toLowerCase();
			const target = Object.values(bot.entities).find((e) => e.name?.toLowerCase() === lowerName);
			if (!target) {
				return textResult(`"${entityName}" が周囲に見つかりません`);
			}

			const jobId = jobManager.startJob("attacking", entityName, (signal, updateProgress) =>
				executeAttack(bot, target, maxHits, signal, updateProgress),
			);

			return textResult(
				`${entityName} への攻撃を開始しました（jobId: ${jobId}, 最大攻撃回数: ${String(maxHits)}）`,
			);
		},
	);
}
