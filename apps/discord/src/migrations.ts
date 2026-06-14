import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";

import type { Logger } from "@vicissitude/shared/types";

/** config 値に応じて指定 id のリマインダーの enabled を同期する */
function syncReminderEnabled(
	configPath: string,
	target: { id: string; configField: string },
	enabled: boolean,
	logger: Logger,
): void {
	if (!existsSync(configPath)) return;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
			reminders?: { id: string; enabled: boolean }[];
		};
		const reminder = raw.reminders?.find((r) => r.id === target.id);
		if (!reminder || reminder.enabled === enabled) return;
		reminder.enabled = enabled;
		writeFileSync(configPath, JSON.stringify(raw, null, 2));
		logger.info(
			`[bootstrap] ${target.id} reminder ${enabled ? "enabled" : "disabled"} (synced with config.${target.configField})`,
		);
	} catch {
		// パース失敗時はスキップ（HeartbeatScheduler がデフォルト設定で初期化する）
	}
}

/** config.minecraft の有無に応じて mc-check リマインダーの enabled を同期する */
export function syncMcCheckReminder(
	configPath: string,
	minecraftEnabled: boolean,
	logger: Logger,
): void {
	syncReminderEnabled(
		configPath,
		{ id: "mc-check", configField: "minecraft" },
		minecraftEnabled,
		logger,
	);
}

/** config.emailCheck の有無に応じて email-check リマインダーの enabled を同期する */
export function syncEmailCheckReminder(
	configPath: string,
	emailCheckEnabled: boolean,
	logger: Logger,
): void {
	syncReminderEnabled(
		configPath,
		{ id: "email-check", configField: "emailCheck" },
		emailCheckEnabled,
		logger,
	);
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
