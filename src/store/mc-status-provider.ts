import type { McStatusProvider } from "../core/types.ts";
import type { StoreDb } from "./db.ts";
import { parseBridgeEvent, peekBridgeEvents } from "./mc-bridge.ts";

const MAX_RECENT_REPORTS = 10;

/**
 * SQLite ブリッジテーブルと MINECRAFT-GOALS.md から Discord 側の
 * Minecraft 状態サマリーを生成する。
 *
 * 出力構造:
 * - 現在の目標（MINECRAFT-GOALS.md）
 * - 最新状況（カテゴリ別: danger > stuck > progress > completion > discovery > status）
 * - 未処理の指示（to_minecraft command）
 */
export class SqliteMcStatusProvider implements McStatusProvider {
	constructor(
		private readonly db: StoreDb,
		private readonly overlayGoalsPath: string,
		private readonly baseGoalsPath: string,
	) {}

	async getStatusSummary(): Promise<string | null> {
		const sections: string[] = [];

		const goalsSection = await this.buildGoalsSection();
		if (goalsSection) sections.push(goalsSection);

		const reportSection = this.buildReportSection();
		if (reportSection) sections.push(reportSection);

		const pendingSection = this.buildPendingCommandsSection();
		if (pendingSection) sections.push(pendingSection);

		if (sections.length === 0) return null;
		return sections.join("\n\n");
	}

	private buildReportSection(): string | null {
		const events = peekBridgeEvents(this.db, "to_discord", MAX_RECENT_REPORTS);
		if (events.length === 0) return null;

		const reports = events.map((e) => parseBridgeEvent(e));

		// カテゴリ別にグループ化（優先度順）
		const dangerReports = reports.filter((r) => r.category === "danger");
		const stuckReports = reports.filter((r) => r.category === "stuck");
		const otherReports = reports.filter(
			(r) => r.category !== "danger" && r.category !== "stuck",
		);

		const lines: string[] = [];

		if (dangerReports.length > 0) {
			lines.push("**⚠ 危険/緊急:**");
			for (const r of dangerReports) lines.push(`- [${r.importance}] ${r.message}`);
		}
		if (stuckReports.length > 0) {
			lines.push("**🔄 行き詰まり:**");
			for (const r of stuckReports) lines.push(`- ${r.message}`);
		}
		if (otherReports.length > 0) {
			lines.push("**直近の出来事:**");
			for (const r of otherReports) {
				const tag = r.category === "status" ? "" : `[${r.category}] `;
				lines.push(`- ${tag}${r.message}`);
			}
		}

		return `## 最新状況\n${lines.join("\n")}`;
	}

	private buildPendingCommandsSection(): string | null {
		const commands = peekBridgeEvents(this.db, "to_minecraft", 5);
		const pending = commands.filter((e) => e.type === "command");
		if (pending.length === 0) return null;

		const lines = pending.map((e) => `- ${e.payload}`);
		return `## 未処理の指示\n${lines.join("\n")}`;
	}

	private async buildGoalsSection(): Promise<string | null> {
		const content = await this.readFile(this.overlayGoalsPath);
		if (content) return `## 現在の目標\n${content}`;

		const baseContent = await this.readFile(this.baseGoalsPath);
		if (baseContent) return `## 現在の目標\n${baseContent}`;

		return null;
	}

	private async readFile(path: string): Promise<string | null> {
		try {
			const content = await Bun.file(path).text();
			const trimmed = content.trim();
			return trimmed || null;
		} catch {
			return null;
		}
	}
}
