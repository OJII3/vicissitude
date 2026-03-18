import type { TtsSynthesizer } from "@vicissitude/shared/ports";
import type { TtsResult, TtsStyleParams } from "@vicissitude/shared/tts";

const DEFAULT_TIMEOUT = 30_000;
const HEALTH_CHECK_TIMEOUT = 5_000;

export function createStyleBertVits2Synthesizer(config: {
	baseUrl: string;
	timeout?: number;
}): TtsSynthesizer {
	const { baseUrl, timeout = DEFAULT_TIMEOUT } = config;

	return {
		synthesize: (text, style) => synthesize(baseUrl, timeout, text, style),
		isAvailable: () => isAvailable(baseUrl),
	};
}

async function synthesize(
	baseUrl: string,
	timeout: number,
	text: string,
	style: TtsStyleParams,
): Promise<TtsResult | null> {
	try {
		const url = new URL("/voice", baseUrl);
		url.searchParams.set("text", text);
		url.searchParams.set("model_id", "0");
		url.searchParams.set("style", capitalize(style.style));
		url.searchParams.set("style_weight", String(style.styleWeight));
		url.searchParams.set("length", String(style.speed));
		url.searchParams.set("language", "JP");

		const response = await fetch(url, {
			method: "POST",
			signal: AbortSignal.timeout(timeout),
		});

		if (!response.ok) return null;

		const buffer = await response.arrayBuffer();
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

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function computeWavDuration(wav: Uint8Array): number {
	// WAV header: find "data" chunk and read size, then divide by byte rate
	// Byte rate is at offset 28 (4 bytes, little-endian)
	// Data chunk: search for "data" marker, data size follows (4 bytes, little-endian)
	if (wav.length < 44) return 0;

	const byteRate = readUint32LE(wav, 28);
	if (byteRate === 0) return 0;

	const dataSize = findDataChunkSize(wav);
	if (dataSize === 0) return 0;

	return dataSize / byteRate;
}

function findDataChunkSize(wav: Uint8Array): number {
	// Search for "data" sub-chunk ID starting after the RIFF header (offset 12)
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
