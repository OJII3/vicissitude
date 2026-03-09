import type { McStatusProvider } from "../core/types.ts";
import type { StoreDb } from "./db.ts";
import { peekBridgeEvents } from "./mc-bridge.ts";

const MAX_RECENT_REPORTS = 5;

/**
 * SQLite ブリッジテーブルと MINECRAFT-GOALS.md からメインブレイン用の
 * Minecraft 状態サマリーを生成する。
 */
export class SqliteMcStatusProvider implements McStatusProvider {
	constructor(
		private readonly db: StoreDb,
		private readonly overlayGoalsPath: string,
		private readonly baseGoalsPath: string,
	) {}

	async getStatusSummary(): Promise<string | null> {
		const sections: string[] = [];

		// 直近レポート
		const reportSection = this.buildReportSection();
		if (reportSection) sections.push(reportSection);

		// 現在の目標
		const goalsSection = await this.buildGoalsSection();
		if (goalsSection) sections.push(goalsSection);

		if (sections.length === 0) return null;
		return sections.join("\n\n");
	}

	private buildReportSection(): string | null {
		const events = peekBridgeEvents(this.db, "to_main");
		if (events.length === 0) return null;

		const recent = events.slice(-MAX_RECENT_REPORTS);
		const lines = recent.map((e) => {
			const ts = new Date(e.createdAt).toISOString();
			if (e.type === "report") {
				const parsed = this.parseReportPayload(e.payload);
				if (parsed) {
					return `- [${ts}] [${parsed.importance}] ${parsed.message}`;
				}
			}
			return `- [${ts}] (${e.type}) ${e.payload}`;
		});
		return `## 直近のレポート\n${lines.join("\n")}`;
	}

	private parseReportPayload(payload: string): { message: string; importance: string } | null {
		try {
			const parsed = JSON.parse(payload) as Record<string, unknown>;
			if (typeof parsed.message === "string" && typeof parsed.importance === "string") {
				return { message: parsed.message, importance: parsed.importance };
			}
		} catch {
			// JSON パース失敗時は null を返す
		}
		return null;
	}

	private async buildGoalsSection(): Promise<string | null> {
		// オーバーレイ優先
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
