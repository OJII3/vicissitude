import type { TtsSynthesizer } from "@vicissitude/shared/ports";
import type {
	TtsResult,
	TtsStyle,
	TtsStyleParams,
	TtsSynthesisFailure,
	TtsSynthesisOutcome,
} from "@vicissitude/shared/tts";
import type { Logger } from "@vicissitude/shared/types";

const DEFAULT_TIMEOUT = 30_000;
const HEALTH_CHECK_TIMEOUT = 5_000;

export type AivisFetch = typeof fetch;

/** style ごとに補間できる Aivis AudioQuery 数値設定 */
export interface AivisAudioQueryStyleConfig {
	readonly pitchScale?: number;
	readonly intonationScale?: number;
	readonly volumeScale?: number;
	readonly prePhonemeLength?: number;
	readonly postPhonemeLength?: number;
}

/** style ごとの Aivis speaker / AudioQuery 設定 */
export interface AivisStyleConfig {
	readonly speakerId?: number;
	readonly audioQuery?: AivisAudioQueryStyleConfig;
}

export type AivisStyleConfigMap = Partial<Record<TtsStyle, AivisStyleConfig>>;

type AivisAudioQueryStyleKey = keyof AivisAudioQueryStyleConfig;

const STYLE_AUDIO_QUERY_KEYS: readonly AivisAudioQueryStyleKey[] = [
	"pitchScale",
	"intonationScale",
	"volumeScale",
	"prePhonemeLength",
	"postPhonemeLength",
];

const STYLE_AUDIO_QUERY_DEFAULTS: Required<AivisAudioQueryStyleConfig> = {
	pitchScale: 0,
	intonationScale: 1,
	volumeScale: 1,
	prePhonemeLength: 0.1,
	postPhonemeLength: 0.1,
};

/** AivisSpeech Engine の AudioQuery レスポンスの最小型 */
interface AudioQuery {
	speedScale: number;
	[key: string]: unknown;
}

export interface AivisSpeechSynthesizerConfig {
	baseUrl: string;
	/** HTTP 副作用を差し替える fetch 実装 */
	fetch?: AivisFetch;
	/** デフォルトの speaker ID */
	speakerId?: number;
	/** style ごとの speaker / AudioQuery 設定 */
	styleConfigs?: AivisStyleConfigMap;
	timeout?: number;
	logger?: Logger;
}

export class AivisSpeechSynthesizer implements TtsSynthesizer {
	private readonly baseUrl: string;
	private readonly fetch: AivisFetch;
	private readonly timeout: number;
	private readonly defaultSpeakerId: number;
	private readonly styleConfigs: AivisStyleConfigMap;
	private readonly logger?: Logger;

	constructor(config: AivisSpeechSynthesizerConfig) {
		this.baseUrl = config.baseUrl;
		this.fetch = config.fetch ?? globalThis.fetch;
		this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
		this.defaultSpeakerId = config.speakerId ?? 0;
		this.styleConfigs = config.styleConfigs ?? {};
		this.logger = config.logger;
	}

	async synthesize(
		text: string,
		style: TtsStyleParams,
		callerSignal?: AbortSignal,
	): Promise<TtsResult | null> {
		const outcome = await this.synthesizeWithReason(text, style, callerSignal);
		return outcome.ok ? outcome.result : null;
	}

	async synthesizeWithReason(
		text: string,
		style: TtsStyleParams,
		callerSignal?: AbortSignal,
	): Promise<TtsSynthesisOutcome> {
		try {
			const styleConfig = this.resolveStyleConfig(style.style);
			const speaker = styleConfig.speakerId ?? this.defaultSpeakerId;

			const timeoutSignal = AbortSignal.timeout(this.timeout);
			const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

			// Step 1: audio_query
			const queryUrl = new URL("/audio_query", this.baseUrl);
			queryUrl.searchParams.set("text", text);
			queryUrl.searchParams.set("speaker", String(speaker));

			const queryResponse = await this.fetch(queryUrl, {
				method: "POST",
				signal,
			});

			if (!queryResponse.ok) {
				return {
					ok: false,
					reason: "audio_query_http_error",
					stage: "audio_query",
					status: queryResponse.status,
					message: queryResponse.statusText || undefined,
				};
			}

			const audioQuery = await this.parseAudioQuery(queryResponse);
			if (!audioQuery.ok) return audioQuery;
			const styledAudioQuery = applyStyleToAudioQuery(audioQuery.result, style, styleConfig);

			// Step 2: synthesis
			const synthUrl = new URL("/synthesis", this.baseUrl);
			synthUrl.searchParams.set("speaker", String(speaker));

			const synthResponse = await this.fetch(synthUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(styledAudioQuery),
				signal,
			});

			if (!synthResponse.ok) {
				return {
					ok: false,
					reason: "synthesis_http_error",
					stage: "synthesis",
					status: synthResponse.status,
					message: synthResponse.statusText || undefined,
				};
			}

			const buffer = await synthResponse.arrayBuffer();
			const audio = new Uint8Array(buffer);
			const durationSec = computeWavDuration(audio);
			if (durationSec <= 0) {
				return {
					ok: false,
					reason: "invalid_audio",
					stage: "wav_validation",
				};
			}

			return { ok: true, result: { audio, format: "wav", durationSec } };
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				return { ok: false, reason: "aborted" };
			}
			this.logger?.warn("[tts] AivisSpeech synthesis failed", error);
			return {
				ok: false,
				reason: error instanceof TypeError ? "network_error" : "unexpected_error",
				message: errorMessage(error),
			};
		}
	}

	async isAvailable(): Promise<boolean> {
		try {
			const response = await this.fetch(this.baseUrl, {
				signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	private resolveStyleConfig(style: TtsStyleParams["style"]): AivisStyleConfig {
		return this.styleConfigs[style] ?? {};
	}

	private async parseAudioQuery(
		response: Response,
	): Promise<{ ok: true; result: AudioQuery } | TtsSynthesisFailure> {
		try {
			return { ok: true, result: (await response.json()) as AudioQuery };
		} catch (error) {
			return {
				ok: false,
				reason: "audio_query_invalid_response",
				stage: "audio_query",
				message: errorMessage(error),
			};
		}
	}
}

function applyStyleToAudioQuery(
	audioQuery: AudioQuery,
	style: TtsStyleParams,
	styleConfig: AivisStyleConfig,
): AudioQuery {
	const styled: AudioQuery = { ...audioQuery, speedScale: style.speed };

	for (const key of STYLE_AUDIO_QUERY_KEYS) {
		const target = styleConfig.audioQuery?.[key];
		if (target === undefined) continue;

		const current = audioQuery[key];
		const base = typeof current === "number" ? current : STYLE_AUDIO_QUERY_DEFAULTS[key];
		styled[key] = blend(base, target, style.styleWeight);
	}

	return styled;
}

function blend(base: number, target: number, weight: number): number {
	return base + (target - base) * weight;
}

function errorMessage(error: unknown): string | undefined {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return undefined;
}

function computeWavDuration(wav: Uint8Array): number {
	if (wav.length < 44) return 0;

	const byteRate = readUint32LE(wav, 28);
	if (byteRate === 0) return 0;

	const dataSize = findDataChunkSize(wav);
	if (dataSize === 0) return 0;

	return dataSize / byteRate;
}

function findDataChunkSize(wav: Uint8Array): number {
	for (let i = 12; i < wav.length - 8; i++) {
		if (wav[i] === 0x64 && wav[i + 1] === 0x61 && wav[i + 2] === 0x74 && wav[i + 3] === 0x61) {
			return readUint32LE(wav, i + 4);
		}
	}
	return 0;
}

function readUint32LE(data: Uint8Array, offset: number): number {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return view.getUint32(offset, true);
}
