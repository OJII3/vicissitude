import type { EmotionCategory } from "@vicissitude/shared/emotion";
import { classifyEmotion } from "@vicissitude/shared/emotion";
import type { MoodReader } from "@vicissitude/shared/ports";
import type { Logger } from "@vicissitude/shared/types";

/** 末尾の ` @xxx` を除去してベース名を返す。末尾空白もトリム。 */
export function extractBaseName(nickname: string): string {
	return nickname.replace(/ @\S+$/, "").trimEnd();
}

/** neutral → baseName のみ, その他 → "{baseName} @{category}" */
export function formatMoodNickname(category: EmotionCategory, baseName: string): string {
	if (category === "neutral") return baseName;
	return `${baseName} @${category}`;
}

export class MoodNicknameService {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly intervalMs: number;
	private readonly defaultName: string;

	// oxlint-disable-next-line max-params -- DI で gateway, moodReader, logger, guildIds, options を受け取る
	constructor(
		private readonly gateway: {
			setGuildNickname(guildId: string, nickname: string | null): Promise<void>;
		},
		private readonly moodReader: MoodReader,
		private readonly logger: Logger,
		private readonly guildIds: string[],
		options?: { intervalMs?: number; defaultName?: string },
	) {
		this.intervalMs = options?.intervalMs ?? 60_000;
		this.defaultName = options?.defaultName ?? "ふあ";
	}

	start(): void {
		if (this.timer) return;
		void this.update();
		this.timer = setInterval(() => void this.update(), this.intervalMs);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	async update(): Promise<void> {
		/* oxlint-disable no-await-in-loop -- 各ギルドのエラーを個別に catch するため逐次実行 */
		for (const guildId of this.guildIds) {
			try {
				const mood = this.moodReader.getMood(`discord:${guildId}`);
				const category = classifyEmotion(mood);
				const nickname = formatMoodNickname(category, this.defaultName);
				await this.gateway.setGuildNickname(guildId, nickname);
			} catch (error) {
				this.logger.warn(`[nickname] failed to update nickname for guild ${guildId}:`, error);
			}
		}
		/* oxlint-enable no-await-in-loop */
	}
}
