import type { McStatusProvider } from "../core/types.ts";
import type { StoreDb } from "./db.ts";
import { getMcConnectionStatus } from "./mc-bridge.ts";

/**
 * mc_session_lock の接続状態と MINECRAFT-GOALS.md から
 * Discord 側の Minecraft 状態サマリーを生成する。
 */
export class SqliteMcStatusProvider implements McStatusProvider {
	constructor(
		private readonly db: StoreDb,
		private readonly overlayGoalsPath: string,
		private readonly baseGoalsPath: string,
	) {}

	async getStatusSummary(): Promise<string | null> {
		const sections: string[] = [];

		const connectionSection = this.buildConnectionSection();
		if (connectionSection) sections.push(connectionSection);

		const goalsSection = await this.buildGoalsSection();
		if (goalsSection) sections.push(goalsSection);

		if (sections.length === 0) return null;
		return sections.join("\n\n");
	}

	private buildConnectionSection(): string | null {
		const status = getMcConnectionStatus(this.db);
		if (status.since === null) return null;
		const label = status.connected ? "接続中" : "未接続";
		return `## 接続状態\n${label}（${status.since}）`;
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
