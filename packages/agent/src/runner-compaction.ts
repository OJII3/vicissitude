import { JST_OFFSET_MS } from "@vicissitude/shared/functions";

export interface ProactiveCompactionInput {
	compactionTokenThreshold: number | undefined;
	now: number;
	lastCompactionAt: number | null;
	compactionCooldownMs: number;
	sessionCreatedAt: number | null;
	sessionMaxAgeMs: number;
	tokens: { input: number; output: number } | undefined;
}

/** 直近 compaction からクールダウン期間内か */
export function isCompactionOnCooldown(
	now: number,
	lastCompactionAt: number | null,
	cooldownMs: number,
): boolean {
	return lastCompactionAt !== null && now - lastCompactionAt < cooldownMs;
}

/**
 * proactive compaction を発火すべきか判定する。
 * - "threshold": トークン閾値超過
 * - "midnight": 深夜帯(2-5 JST) かつセッション半寿命 & トークン半閾値
 * - "cooldown": クールダウン中（呼び出し元は debug ログを出す）
 * - "none": 発火しない
 */
export function evaluateProactiveCompaction(
	input: ProactiveCompactionInput,
): "threshold" | "midnight" | "cooldown" | "none" {
	if (input.compactionTokenThreshold === undefined) return "none";

	if (isCompactionOnCooldown(input.now, input.lastCompactionAt, input.compactionCooldownMs)) {
		return "cooldown";
	}

	if (input.tokens) {
		const total = input.tokens.input + input.tokens.output;
		if (total >= input.compactionTokenThreshold) return "threshold";
	}

	const jstHour = new Date(input.now + JST_OFFSET_MS).getUTCHours();
	if (jstHour >= 2 && jstHour < 5 && input.sessionCreatedAt !== null && input.tokens) {
		const total = input.tokens.input + input.tokens.output;
		const age = input.now - input.sessionCreatedAt;
		if (age >= input.sessionMaxAgeMs / 2 && total >= input.compactionTokenThreshold / 2) {
			return "midnight";
		}
	}

	return "none";
}
