export type Importance = "low" | "medium" | "high";

export interface ActionState {
	type: "idle" | "following" | "moving" | "collecting" | "crafting" | "sleeping";
	target?: string;
	jobId?: string;
	progress?: string;
}

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobInfo {
	id: string;
	type: ActionState["type"];
	target: string;
	status: JobStatus;
	startedAt: Date;
	finishedAt?: Date;
	error?: string;
}

export const IMPORTANCE_ORDER: Record<Importance, number> = { low: 1, medium: 2, high: 3 };

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
		case "sleeping":
			base = `${action.target ?? "?"} で就寝中`;
			break;
	}
	if (action.progress) base += ` (${action.progress})`;
	return base;
}
