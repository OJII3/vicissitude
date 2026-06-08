import type { Emotion, EmotionCategory } from "@vicissitude/shared/emotion";
import { NEUTRAL_EMOTION, classifyEmotion } from "@vicissitude/shared/emotion";
import type { MoodReader } from "@vicissitude/shared/ports";
import type { Logger } from "@vicissitude/shared/types";

const EMOJI_MAP: Record<EmotionCategory, string> = {
	happy: "\u{1F7E1}",
	relaxed: "\u{1F7E2}",
	neutral: "⚪",
	surprised: "\u{1F7E3}",
	angry: "\u{1F534}",
	fear: "\u{1F7E0}",
	sad: "\u{1F535}",
};

/** VAD 感情値を色絵文字+カテゴリ名のステータス文字列に変換する */
export function formatMoodStatus(emotion: Emotion): string {
	const category = classifyEmotion(emotion);
	return `${EMOJI_MAP[category]} ${category}`;
}

export interface MoodPresenceOptions {
	intervalMs?: number;
	agentIds?: string[];
}

export class MoodPresenceService {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly intervalMs: number;
	private readonly agentIds: string[];

	constructor(
		private readonly gateway: { setWatchingActivity(name: string): void },
		private readonly moodReader: MoodReader,
		private readonly logger: Logger,
		options: MoodPresenceOptions = {},
	) {
		this.intervalMs = options.intervalMs ?? 60_000;
		this.agentIds = options.agentIds ?? [];
	}

	start(): void {
		if (this.timer) return;
		this.update();
		this.timer = setInterval(() => this.update(), this.intervalMs);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	update(): void {
		try {
			let emotion: Emotion = NEUTRAL_EMOTION;
			for (const agentId of this.agentIds) {
				const mood = this.moodReader.getMood(agentId);
				if (classifyEmotion(mood) !== "neutral") {
					emotion = mood;
					break;
				}
			}
			this.gateway.setWatchingActivity(formatMoodStatus(emotion));
		} catch (error) {
			this.logger.warn("[presence] failed to update mood presence:", error);
		}
	}
}
