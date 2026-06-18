import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

import { ContextBuilder, type ContextFileName } from "@vicissitude/agent/discord/context-builder";
import { discordGuildIdFromScopeId } from "@vicissitude/memory/namespace";
import type { MemoryFactReader, SessionSummaryWriter } from "@vicissitude/shared/types";
import { createDb } from "@vicissitude/store/db";
import { createSqliteSessionStore } from "@vicissitude/store/session-store";

import type { AppConfig } from "../config.ts";

// ─── Store Layer ────────────────────────────────────────────────

export function createStoreLayer(config: AppConfig) {
	const db = createDb(config.dataDir);
	const sessionStore = createSqliteSessionStore(db);
	return { db, sessionStore };
}

// ─── Context Layer ──────────────────────────────────────────────

export function createContextLayer(
	_config: AppConfig,
	root: string,
	factReader?: MemoryFactReader,
) {
	const contextBuilder = new ContextBuilder(
		resolve(root, "data/context"),
		resolve(root, "context"),
		factReader,
	);
	return { contextBuilder };
}

export function createWebContextLayer(
	config: AppConfig,
	root: string,
	factReader?: MemoryFactReader,
) {
	const excludeFiles = new Set<ContextFileName>(["DISCORD.md", "HEARTBEAT.md", "TOOLS-DISCORD.md"]);
	const contextBuilder = new ContextBuilder(
		resolve(root, "data/context"),
		resolve(root, "context"),
		factReader,
		excludeFiles,
	);
	return { contextBuilder };
}

// ─── Guild Agents ───────────────────────────────────────────────

export function createFileSessionSummaryWriter(
	overlayDir: string,
	onWrite?: (guildId: string) => Promise<void>,
): SessionSummaryWriter {
	return {
		async write(scopeId: string, content: string): Promise<void> {
			const guildId = discordGuildIdFromScopeId(scopeId);
			const dir = guildId
				? resolve(overlayDir, `guilds/${guildId}`)
				: resolve(overlayDir, `scopes/${encodeURIComponent(scopeId)}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(resolve(dir, "SESSION-SUMMARY.md"), content);
			if (guildId) await onWrite?.(guildId);
		},
	};
}
