import type { TtsSynthesizer } from "@vicissitude/shared/ports";
import type { TtsResult, TtsStyleParams } from "@vicissitude/shared/tts";

const DEFAULT_TIMEOUT = 30_000;
const HEALTH_CHECK_TIMEOUT = 5_000;

/** style → speaker ID のマッピング設定 */
export type StyleSpeakerMap = Partial<Record<TtsStyleParams["style"], number>>;

interface SynthesizeConfig {
	baseUrl: string;
	timeout: number;
	defaultSpeakerId: number;
	styleSpeakerMap: StyleSpeakerMap;
}

/** AivisSpeech Engine の AudioQuery レスポンスの最小型 */
interface AudioQuery {
	speedScale: number;
	[key: string]: unknown;
}

export function createAivisSpeechSynthesizer(config: {
	baseUrl: string;
	/** デフォルトの speaker ID */
	speakerId?: number;
	/** style ごとの speaker ID マッピング（未設定の style はデフォルト speaker を使用） */
	styleSpeakerMap?: StyleSpeakerMap;
	timeout?: number;
}): TtsSynthesizer {
	const { baseUrl, speakerId = 0, styleSpeakerMap = {}, timeout = DEFAULT_TIMEOUT } = config;

	const synthConfig: SynthesizeConfig = {
		baseUrl,
		timeout,
		defaultSpeakerId: speakerId,
		styleSpeakerMap,
	};

	return {
		synthesize: (text, style) => synthesize(synthConfig, text, style),
		isAvailable: () => isAvailable(baseUrl),
	};
}

function resolveSpeakerId(
	defaultId: number,
	styleSpeakerMap: StyleSpeakerMap,
	style: TtsStyleParams["style"],
): number {
	return styleSpeakerMap[style] ?? defaultId;
}

async function synthesize(
	config: SynthesizeConfig,
	text: string,
	style: TtsStyleParams,
): Promise<TtsResult | null> {
	try {
		const { baseUrl, timeout, defaultSpeakerId, styleSpeakerMap } = config;
		const speaker = resolveSpeakerId(defaultSpeakerId, styleSpeakerMap, style.style);

		// Step 1: audio_query
		const queryUrl = new URL("/audio_query", baseUrl);
		queryUrl.searchParams.set("text", text);
		queryUrl.searchParams.set("speaker", String(speaker));

		const queryResponse = await fetch(queryUrl, {
			method: "POST",
			signal: AbortSignal.timeout(timeout),
		});

		if (!queryResponse.ok) return null;

		const audioQuery = (await queryResponse.json()) as AudioQuery;

		audioQuery.speedScale = style.speed;

		// Step 2: synthesis
		const synthUrl = new URL("/synthesis", baseUrl);
		synthUrl.searchParams.set("speaker", String(speaker));

		const synthResponse = await fetch(synthUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(audioQuery),
			signal: AbortSignal.timeout(timeout),
		});

		if (!synthResponse.ok) return null;

		const buffer = await synthResponse.arrayBuffer();
		const audio = new Uint8Array(buffer);
		const durationSec = computeWavDuration(audio);

		return { audio, format: "wav", durationSec };
	} catch {
		return null;
	}
}

async function isAvailable(baseUrl: string): Promise<boolean> {
	try {
		const response = await fetch(baseUrl, {
			signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
		});
		return response.ok;
	} catch {
		return false;
	}
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
