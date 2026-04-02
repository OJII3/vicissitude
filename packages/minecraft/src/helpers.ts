export type Importance = "low" | "medium" | "high" | "critical";

export interface ActionState {
	type:
		| "idle"
		| "eating"
		| "following"
		| "moving"
		| "collecting"
		| "crafting"
		| "smelting"
		| "sleeping"
		| "fleeing"
		| "sheltering"
		| "attacking"
		| "searching"
		| "exploring";
	target?: string;
	jobId?: string;
	progress?: string;
}

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobInfo {
	id: string;
	type: Exclude<ActionState["type"], "idle">;
	target: string;
	status: JobStatus;
	startedAt: Date;
	finishedAt?: Date;
	error?: string;
}

export const IMPORTANCE_ORDER: Record<Importance, number> = {
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

/** Minecraft のゲーム内時間 (0–23999) から時間帯を返す */
export function getTimePeriod(timeOfDay: number): string {
	if (timeOfDay < 6000) return "朝";
	if (timeOfDay < 12000) return "昼";
	if (timeOfDay < 13000) return "夕";
	return "夜";
}

/** hostile mob の名前リスト（Minecraft Java Edition の一般的なもの） */
const HOSTILE_MOBS = new Set([
	"zombie",
	"skeleton",
	"creeper",
	"spider",
	"enderman",
	"witch",
	"slime",
	"phantom",
	"drowned",
	"husk",
	"stray",
	"blaze",
	"ghast",
	"magma_cube",
	"wither_skeleton",
	"pillager",
	"vindicator",
	"evoker",
	"ravager",
	"vex",
	"guardian",
	"elder_guardian",
	"shulker",
	"piglin_brute",
	"warden",
	"breeze",
]);

/** エンティティ名が hostile mob かどうかを判定する */
export function isHostileMob(name: string): boolean {
	return HOSTILE_MOBS.has(name.toLowerCase());
}

/** 体力を ♥ バーで表示する（体力2ごとに1つのハート） */
export function formatHealthBar(health: number): string {
	const maxHearts = 10;
	const filledHearts = Math.ceil(health / 2);
	const filled = "♥".repeat(Math.min(filledHearts, maxHearts));
	const empty = "♡".repeat(Math.max(0, maxHearts - filledHearts));
	return `${filled}${empty} (${String(Math.round(health))}/20)`;
}

/** インベントリを1行テキストで要約する */
export function formatInventoryText(
	items: { name: string; count: number }[],
	_emptySlots: number,
): string {
	if (items.length === 0) return "空";
	const itemTexts = items.map((i) => (i.count > 1 ? `${i.name} x${String(i.count)}` : i.name));
	return itemTexts.join(", ");
}

/** 装備を1行テキストで要約する */
export function formatEquipmentText(equipment: Record<string, string>): string {
	const labels: Record<string, string> = {
		hand: "手",
		head: "頭",
		chest: "胴",
		legs: "脚",
		feet: "足",
		offhand: "オフハンド",
	};
	const parts: string[] = [];
	for (const [slot, item] of Object.entries(equipment)) {
		parts.push(`${labels[slot] ?? slot}: ${item}`);
	}
	return parts.length > 0 ? parts.join(", ") : "なし";
}

/** エンティティ情報を表示用テキストに変換する */
export function formatEntityEntry(entity: {
	name: string;
	distance: number;
	type: string;
}): string {
	const hostile = entity.type === "mob" && isHostileMob(entity.name);
	const warning = hostile ? " ⚠" : "";
	const typeLabel = entity.type === "player" ? "プレイヤー" : entity.type;
	return `- ${entity.name} (${typeLabel}, ${String(entity.distance)}m)${warning}`;
}

/** アクション状態を表示用テキストに変換する */
export function formatActionState(action: ActionState): string {
	let base: string;
	switch (action.type) {
		case "idle":
			return "待機中";
		case "eating":
			base = `${action.target ?? "?"} を食事中`;
			break;
		case "following":
			base = `${action.target ?? "?"} を追従中`;
			break;
		case "moving":
			base = `${action.target ?? "?"} へ移動中`;
			break;
		case "collecting":
			base = `${action.target ?? "?"} を採集中`;
			break;
		case "crafting":
			base = `${action.target ?? "?"} をクラフト中`;
			break;
		case "smelting":
			base = `${action.target ?? "?"} を精錬中`;
			break;
		case "sleeping":
			base = `${action.target ?? "?"} で就寝中`;
			break;
		case "fleeing":
			base = `${action.target ?? "?"} から逃走中`;
			break;
		case "sheltering":
			base = `${action.target ?? "?"} へ避難中`;
			break;
		case "attacking":
			base = `${action.target ?? "?"} を攻撃中`;
			break;
		case "searching":
			base = `${action.target ?? "?"} を探索中`;
			break;
		case "exploring":
			base = `${action.target ?? "?"} 方面を探検中`;
			break;
	}
	if (action.progress) base += ` (${action.progress})`;
	return base;
}

export function classifyFailure(error?: string): string {
	if (!error) return "unknown failure";
	const normalized = error.toLowerCase();
	if (
		normalized.includes("材料") ||
		normalized.includes("recipe") ||
		normalized.includes("レシピ") ||
		normalized.includes("食料") ||
		normalized.includes("作業台") ||
		normalized.includes("かまど") ||
		normalized.includes("燃料") ||
		normalized.includes("furnace")
	) {
		return "resource shortage";
	}
	if (
		normalized.includes("path") ||
		normalized.includes("到達") ||
		normalized.includes("goal") ||
		normalized.includes("パス")
	) {
		return "pathfinding failure";
	}
	if (
		normalized.includes("見つかりません") ||
		normalized.includes("ベッド") ||
		normalized.includes("プレイヤー") ||
		normalized.includes("エンティティ") ||
		normalized.includes("ブロック") ||
		normalized.includes("なくな") ||
		normalized.includes("離脱")
	) {
		return "target missing";
	}
	if (
		normalized.includes("disconnect") ||
		normalized.includes("接続") ||
		normalized.includes("kicked")
	) {
		return "connection failure";
	}
	return "survival failure";
}

// 主要鉱石の Y 座標分布テーブル
export const ORE_Y_DISTRIBUTION: Record<string, { minY: number; maxY: number }> = {
	diamond_ore: { minY: -64, maxY: 16 },
	iron_ore: { minY: -64, maxY: 72 },
	gold_ore: { minY: -64, maxY: 32 },
	coal_ore: { minY: 0, maxY: 320 },
	lapis_ore: { minY: -64, maxY: 64 },
	redstone_ore: { minY: -64, maxY: 16 },
	emerald_ore: { minY: -16, maxY: 320 },
	copper_ore: { minY: -16, maxY: 112 },
};

// 鉱石名からY座標ヒント文字列を返す。鉱石でなければ null
export function getOreHint(blockName: string): string | null {
	const entry = ORE_Y_DISTRIBUTION[blockName];
	if (!entry) return null;
	return `${blockName} は Y=${String(entry.minY)}〜${String(entry.maxY)} に分布`;
}

export function totalTravelDistance(snapshots: { x: number; y: number; z: number }[]): number {
	let total = 0;
	for (let i = 1; i < snapshots.length; i++) {
		const prev = snapshots.at(i - 1);
		const curr = snapshots.at(i);
		if (!prev || !curr) continue;
		const dx = curr.x - prev.x;
		const dy = curr.y - prev.y;
		const dz = curr.z - prev.z;
		total += Math.sqrt(dx * dx + dy * dy + dz * dz);
	}
	return total;
}
