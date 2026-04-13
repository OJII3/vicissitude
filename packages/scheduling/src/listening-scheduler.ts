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
/** now_playing ポーリング間隔 (10秒) */
const NOW_PLAYING_POLL_INTERVAL_MS = 10_000;

const LISTENING_PROMPT = [
	"今から一曲選んで聴き、感想を書いて記録してください。",
	"選曲には `spotify_pick_track`、歌詞は `fetch_lyrics`、感想は `save_listening_fact` を使ってください。",
	"曲を選んだら、`set_now_playing` でプレゼンス表示を設定してください。",
].join("\n");

export interface ListeningPresencePort {
	setListeningActivity(trackName: string): void;
	clearActivity(): void;
}

/** store から now_playing を消費するポート */
export interface NowPlayingReader {
	consume(): { trackName: string; updatedAt: number } | null;
}

export interface ListeningSchedulerDeps {
	agent: AiAgent;
	presence: ListeningPresencePort;
	nowPlayingReader: NowPlayingReader;
	logger: Logger;
	metrics?: MetricsCollector;
	/** テスト用: 確率判定の注入。未指定時はデフォルトの時間帯ベース判定 */
	shouldStart?: () => boolean;
}

export class ListeningScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private nowPlayingTimer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private executePromise: Promise<void> | null = null;
	private readonly agent: AiAgent;
	private readonly presence: ListeningPresencePort;
	private readonly nowPlayingReader: NowPlayingReader;
	private readonly logger: Logger;
	private readonly metrics: MetricsCollector | undefined;
	private readonly shouldStart: () => boolean;

	constructor(deps: ListeningSchedulerDeps) {
		this.agent = deps.agent;
		this.presence = deps.presence;
		this.nowPlayingReader = deps.nowPlayingReader;
		this.logger = deps.logger;
		this.metrics = deps.metrics;
		this.shouldStart = deps.shouldStart ?? (() => shouldStartListening(new Date(), Math.random));
	}

	start(): void {
		if (this.timer) return;
		this.logger.info("[listening] scheduler started (4min interval)");
		this.timer = setInterval(() => void this.tick(), LISTENING_TICK_INTERVAL_MS);
		this.nowPlayingTimer = setInterval(() => this.pollNowPlaying(), NOW_PLAYING_POLL_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.nowPlayingTimer) {
			clearInterval(this.nowPlayingTimer);
			this.nowPlayingTimer = null;
		}
		if (this.executePromise) {
			await this.executePromise.catch(() => {});
		}
		this.logger.info("[listening] scheduler stopped");
	}

	private pollNowPlaying(): void {
		const entry = this.nowPlayingReader.consume();
		if (entry) {
			this.logger.info(`[listening] now_playing consumed: ${entry.trackName}`);
			this.presence.setListeningActivity(entry.trackName);
		}
	}

	private async tick(): Promise<void> {
		if (this.running) {
			this.logger.info("[listening] previous tick still running, skipping");
			return;
		}
		const should = this.shouldStart();
		this.logger.debug(`[listening] tick: shouldStart=${should}`);
		if (!should) return;

		this.logger.info("[listening] tick started");
		this.running = true;
		const start = performance.now();
		const execution = this.executeTick();
		this.executePromise = execution;
		try {
			await withTimeout(execution, LISTENING_TICK_TIMEOUT_MS, "listening tick timed out");
			this.metrics?.incrementCounter(METRIC.LISTENING_TICKS, { outcome: "success" });
		} catch (error) {
			this.metrics?.incrementCounter(METRIC.LISTENING_TICKS, { outcome: "error" });
			this.logger.error("[listening] tick error:", error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics?.observeHistogram(METRIC.LISTENING_TICK_DURATION, duration);
			this.executePromise = null;
			this.running = false;
		}
	}

	private async executeTick(): Promise<void> {
		await this.agent.send({
			sessionKey: LISTENING_SESSION_KEY,
			message: LISTENING_PROMPT,
		});
		this.logger.info("[listening] tick message sent to agent (fire-and-forget)");
	}
}
