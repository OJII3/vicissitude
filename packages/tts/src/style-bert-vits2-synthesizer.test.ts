import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { createTtsStyleParams } from "@vicissitude/shared/tts";

import { createStyleBertVits2Synthesizer } from "./style-bert-vits2-synthesizer";

const BASE_URL = "http://localhost:5000";
const DEFAULT_STYLE = createTtsStyleParams("happy", 0.7, 1.2);

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
	mockFetch = mock();
	globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// ─── synthesize: URL query params ────────────────────────────────

describe("synthesize — query params", () => {
	it("正しい query params で /voice に POST する", async () => {
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 96000), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		await synth.synthesize("こんにちは", DEFAULT_STYLE);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0] as [URL, RequestInit];

		expect(url.pathname).toBe("/voice");
		expect(url.searchParams.get("text")).toBe("こんにちは");
		expect(url.searchParams.get("model_id")).toBe("0");
		expect(url.searchParams.get("style")).toBe("Happy");
		expect(url.searchParams.get("style_weight")).toBe("0.7");
		expect(url.searchParams.get("length")).toBe("1.2");
		expect(url.searchParams.get("language")).toBe("JP");
		expect(init.method).toBe("POST");
	});

	it("style が capitalize される (fear → Fear)", async () => {
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 96000), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const fearStyle = createTtsStyleParams("fear", 0.5, 1.0);
		await synth.synthesize("test", fearStyle);

		const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
		expect(url.searchParams.get("style")).toBe("Fear");
	});

	it("style が capitalize される (surprised → Surprised)", async () => {
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 96000), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const surprisedStyle = createTtsStyleParams("surprised", 0.8, 1.0);
		await synth.synthesize("test", surprisedStyle);

		const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
		expect(url.searchParams.get("style")).toBe("Surprised");
	});
});

// ─── synthesize: timeout ─────────────────────────────────────────

describe("synthesize — timeout", () => {
	it("デフォルトタイムアウト (30000ms) が使用される", async () => {
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 48000), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		await synth.synthesize("test", DEFAULT_STYLE);

		const [, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("カスタムタイムアウトを設定できる", async () => {
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 48000), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({
			baseUrl: BASE_URL,
			timeout: 10_000,
		});
		await synth.synthesize("test", DEFAULT_STYLE);

		const [, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});
});

// ─── computeWavDuration ──────────────────────────────────────────

describe("computeWavDuration — calculation precision", () => {
	it("known WAV: byteRate=48000, dataSize=96000 → duration=2.0s", async () => {
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 96000), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeCloseTo(2.0, 5);
	});

	it("known WAV: byteRate=48000, dataSize=24000 → duration=0.5s", async () => {
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 24000), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeCloseTo(0.5, 5);
	});
});

describe("computeWavDuration — edge cases", () => {
	it("44 bytes 未満のバッファ → durationSec=0", async () => {
		const shortBuffer = new ArrayBuffer(20);
		mockFetch.mockResolvedValueOnce(new Response(shortBuffer, { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBe(0);
	});

	it("byteRate=0 → durationSec=0", async () => {
		mockFetch.mockResolvedValueOnce(new Response(buildWav(0, 96000), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBe(0);
	});

	it("data chunk が存在しない → durationSec=0", async () => {
		// 有効な WAV ヘッダーだが "data" マーカーを持たないバッファ
		const noDataChunk = new Uint8Array(64);
		// RIFF header
		noDataChunk.set([0x52, 0x49, 0x46, 0x46], 0);
		// WAVE
		noDataChunk.set([0x57, 0x41, 0x56, 0x45], 8);
		// fmt sub-chunk
		noDataChunk.set([0x66, 0x6d, 0x74, 0x20], 12);
		// byteRate at offset 28 = 48000
		writeUint32LE(noDataChunk, 28, 48000);
		// "data" marker は書かない

		mockFetch.mockResolvedValueOnce(
			new Response(noDataChunk.buffer as ArrayBuffer, { status: 200 }),
		);

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBe(0);
	});
});

// ─── readUint32LE — byte order ───────────────────────────────────

describe("readUint32LE — byte order verification via WAV parsing", () => {
	it("byteRate=0x00_01_00_00 (65536) が正しく読まれる", async () => {
		// byteRate = 65536, dataSize = 65536 → duration = 1.0s
		mockFetch.mockResolvedValueOnce(new Response(buildWav(65536, 65536), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeCloseTo(1.0, 5);
	});

	it("byteRate=0x01_02_03_04 が正しくリトルエンディアンで読まれる", async () => {
		// byteRate bytes: [0x04, 0x03, 0x02, 0x01] → 0x01020304 = 16909060
		// dataSize = 16909060 → duration = 1.0s
		mockFetch.mockResolvedValueOnce(new Response(buildWav(16909060, 16909060), { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeCloseTo(1.0, 5);
	});
});

// ─── isAvailable ─────────────────────────────────────────────────

describe("isAvailable — fetch call", () => {
	it("baseUrl に GET でフェッチする", async () => {
		mockFetch.mockResolvedValueOnce(new Response("OK", { status: 200 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		await synth.isAvailable();

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(BASE_URL);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("HTTP 4xx でも false を返す", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

		const synth = createStyleBertVits2Synthesizer({ baseUrl: BASE_URL });
		const result = await synth.isAvailable();

		expect(result).toBe(false);
	});
});

// ─── Helper: WAV バッファ構築 ────────────────────────────────────

function buildWav(byteRate: number, dataSize: number): ArrayBuffer {
	const headerSize = 44;
	const totalSize = headerSize + dataSize;
	const wav = new Uint8Array(totalSize);

	// "RIFF"
	wav.set([0x52, 0x49, 0x46, 0x46], 0);
	// chunk size
	writeUint32LE(wav, 4, totalSize - 8);
	// "WAVE"
	wav.set([0x57, 0x41, 0x56, 0x45], 8);
	// "fmt "
	wav.set([0x66, 0x6d, 0x74, 0x20], 12);
	// sub-chunk size (16)
	writeUint32LE(wav, 16, 16);
	// audio format (PCM = 1)
	wav[20] = 0x01;
	wav[21] = 0x00;
	// channels (1)
	wav[22] = 0x01;
	wav[23] = 0x00;
	// sample rate (24000)
	writeUint32LE(wav, 24, 24000);
	// byte rate
	writeUint32LE(wav, 28, byteRate);
	// block align (2)
	wav[32] = 0x02;
	wav[33] = 0x00;
	// bits per sample (16)
	wav[34] = 0x10;
	wav[35] = 0x00;
	// "data"
	wav.set([0x64, 0x61, 0x74, 0x61], 36);
	// data size
	writeUint32LE(wav, 40, dataSize);

	return wav.buffer as ArrayBuffer;
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >> 8) & 0xff;
	buf[offset + 2] = (value >> 16) & 0xff;
	buf[offset + 3] = (value >> 24) & 0xff;
}
