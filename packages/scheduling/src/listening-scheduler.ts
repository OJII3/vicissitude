import { METRIC } from "@vicissitude/observability/metrics";
import { withTimeout } from "@vicissitude/shared/functions";
import type { AiAgent, Logger, MetricsCollector } from "@vicissitude/shared/types";

import { shouldStartListening } from "./listening-schedule.ts";

/** 4 分間隔で tick */
const LISTENING_TICK_INTERVAL_MS = 240_000;
/** tick タイムアウト (3 分) */
const LISTENING_TICK_TIMEOUT_MS = 180_000;
/** sessionKey 固定 */
const LISTENING_SESSION_KEY = "listening";

/** NOW_PLAYING: <曲名> - <アーティスト名> を抽出する正規表現 */
const NOW_PLAYING_RE = /NOW_PLAYING:\s*(.+)$/m;

const LISTENING_PROMPT = [
	"今から一曲選んで聴き、感想を書いて記録してください。",
	"選曲には `spotify_pick_track`、歌詞は `fetch_lyrics`、感想は `save_listening_fact` を使ってください。",
	"曲を選んだら、プレゼンス表示のために最後の行に `NOW_PLAYING: <曲名> - <アーティスト名>` の形式で出力してください。",
].join("\n");

export interface ListeningPresencePort {
	setListeningActivity(trackName: string): void;
	clearActivity(): void;
}

export interface ListeningSchedulerDeps {
	agent: AiAgent;
	presence: ListeningPresencePort;
	logger: Logger;
	metrics?: MetricsCollector;
	/** テスト用: 確率判定の注入。未指定時はデフォルトの時間帯ベース判定 */
	shouldStart?: () => boolean;
}

export class ListeningScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private executePromise: Promise<void> | null = null;
	private readonly agent: AiAgent;
	private readonly presence: ListeningPresencePort;
	private readonly logger: Logger;
	private readonly metrics: MetricsCollector | undefined;
	private readonly shouldStart: () => boolean;

	constructor(deps: ListeningSchedulerDeps) {
		this.agent = deps.agent;
		this.presence = deps.presence;
		this.logger = deps.logger;
		this.metrics = deps.metrics;
		this.shouldStart = deps.shouldStart ?? (() => shouldStartListening(new Date(), Math.random));
	}

	start(): void {
		if (this.timer) return;
		this.logger.info("[listening] スケジューラ開始（4分間隔）");
		this.timer = setInterval(() => void this.tick(), LISTENING_TICK_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.executePromise) {
			await this.executePromise.catch(() => {});
		}
		this.logger.info("[listening] スケジューラ停止");
	}

	private async tick(): Promise<void> {
		if (this.running) {
			this.logger.info("[listening] 前回の実行がまだ進行中、スキップ");
			return;
		}
		if (!this.shouldStart()) return;

		this.running = true;
		const start = performance.now();
		const execution = this.executeTick();
		this.executePromise = execution;
		try {
			await withTimeout(execution, LISTENING_TICK_TIMEOUT_MS, "listening tick timed out");
			this.metrics?.incrementCounter(METRIC.LISTENING_TICKS, { outcome: "success" });
		} catch (error) {
			this.metrics?.incrementCounter(METRIC.LISTENING_TICKS, { outcome: "error" });
			this.logger.error("[listening] tick エラー:", error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics?.observeHistogram(METRIC.LISTENING_TICK_DURATION, duration);
			this.executePromise = null;
			this.running = false;
		}
	}

	private async executeTick(): Promise<void> {
		const response = await this.agent.send({
			sessionKey: LISTENING_SESSION_KEY,
			message: LISTENING_PROMPT,
		});
		const match = NOW_PLAYING_RE.exec(response.text);
		if (match) {
			const trackName = match[1]?.trim();
			if (trackName) {
				this.presence.setListeningActivity(trackName);
			}
		}
	}
}
