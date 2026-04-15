import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";

import type { Logger } from "@vicissitude/shared/types";

/** config.minecraft の有無に応じて mc-check リマインダーの enabled を同期する */
export function syncMcCheckReminder(
	configPath: string,
	minecraftEnabled: boolean,
	logger: Logger,
): void {
	if (!existsSync(configPath)) return;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
			reminders?: { id: string; enabled: boolean }[];
		};
		const mcCheck = raw.reminders?.find((r) => r.id === "mc-check");
		if (!mcCheck || mcCheck.enabled === minecraftEnabled) return;
		mcCheck.enabled = minecraftEnabled;
		writeFileSync(configPath, JSON.stringify(raw, null, 2));
		logger.info(
			`[bootstrap] mc-check reminder ${minecraftEnabled ? "enabled" : "disabled"} (synced with config.minecraft)`,
		);
	} catch {
		// パース失敗時はスキップ（HeartbeatScheduler がデフォルト設定で初期化する）
	}
}

/** ltm-consolidate リマインダーを削除する（MCP ツール廃止に伴う移行） */
export function removeLegacyConsolidateReminder(configPath: string, logger: Logger): void {
	if (!existsSync(configPath)) return;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
			reminders?: { id: string }[];
		};
		if (!raw.reminders) return;
		const idx = raw.reminders.findIndex((r) => r.id === "ltm-consolidate");
		if (idx === -1) return;
		raw.reminders.splice(idx, 1);
		writeFileSync(configPath, JSON.stringify(raw, null, 2));
		logger.info("[bootstrap] Removed ltm-consolidate reminder (consolidation is now automatic)");
	} catch {
		// パース失敗時はスキップ
	}
}

/** data/ltm → data/memory のディレクトリ移行 */
export function migrateMemoryDir(dataDir: string, logger: Logger): void {
	const oldMemoryDir = resolve(dataDir, "ltm");
	const newMemoryDir = resolve(dataDir, "memory");
	if (existsSync(oldMemoryDir) && !existsSync(newMemoryDir)) {
		renameSync(oldMemoryDir, newMemoryDir);
		logger.info("[bootstrap] Migrated data/ltm → data/memory");
	}
}
