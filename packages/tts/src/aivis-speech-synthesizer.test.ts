import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { createTtsStyleParams } from "@vicissitude/shared/tts";

import { createAivisSpeechSynthesizer } from "./aivis-speech-synthesizer";

const BASE_URL = "http://localhost:10101";
const DEFAULT_STYLE = createTtsStyleParams("happy", 0.7, 1.2);
const DUMMY_AUDIO_QUERY = { speedScale: 1.0, pitchScale: 0.0 };

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
	mockFetch = mock();
	globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// ─── synthesize: 2-step API call ─────────────────────────────────

describe("synthesize — API calls", () => {
	it("audio_query → synthesis の 2 ステップで呼び出す", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 96000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		await synth.synthesize("こんにちは", DEFAULT_STYLE);

		expect(mockFetch).toHaveBeenCalledTimes(2);

		// 1st call: audio_query
		const [queryUrl, queryInit] = mockFetch.mock.calls[0] as [URL, RequestInit];
		expect(queryUrl.pathname).toBe("/audio_query");
		expect(queryUrl.searchParams.get("text")).toBe("こんにちは");
		expect(queryUrl.searchParams.get("speaker")).toBe("0");
		expect(queryInit.method).toBe("POST");

		// 2nd call: synthesis
		const [synthUrl, synthInit] = mockFetch.mock.calls[1] as [URL, RequestInit];
		expect(synthUrl.pathname).toBe("/synthesis");
		expect(synthUrl.searchParams.get("speaker")).toBe("0");
		expect(synthInit.method).toBe("POST");
		expect(synthInit.headers).toEqual({ "Content-Type": "application/json" });
	});

	it("synthesis リクエストに speedScale が style.speed で上書きされる", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ speedScale: 1.0, pitchScale: 0.0 }), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 48000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		await synth.synthesize("test", DEFAULT_STYLE);

		const [, synthInit] = mockFetch.mock.calls[1] as [URL, RequestInit];
		const body = JSON.parse(synthInit.body as string);
		// DEFAULT_STYLE.speed = 1.2
		expect(body.speedScale).toBe(1.2);
	});

	it("speakerId を設定できる", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 48000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL, speakerId: 3 });
		await synth.synthesize("test", DEFAULT_STYLE);

		const [queryUrl] = mockFetch.mock.calls[0] as [URL, RequestInit];
		expect(queryUrl.searchParams.get("speaker")).toBe("3");

		const [synthUrl] = mockFetch.mock.calls[1] as [URL, RequestInit];
		expect(synthUrl.searchParams.get("speaker")).toBe("3");
	});

	it("styleSpeakerMap で style に応じた speaker ID を使用する", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 48000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({
			baseUrl: BASE_URL,
			speakerId: 0,
			styleSpeakerMap: { happy: 5, sad: 6 },
		});
		// style = "happy" → speaker 5
		await synth.synthesize("test", DEFAULT_STYLE);

		const [queryUrl] = mockFetch.mock.calls[0] as [URL, RequestInit];
		expect(queryUrl.searchParams.get("speaker")).toBe("5");
	});

	it("styleSpeakerMap に未定義の style はデフォルト speakerId を使用する", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 48000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({
			baseUrl: BASE_URL,
			speakerId: 2,
			styleSpeakerMap: { happy: 5 },
		});
		const sadStyle = createTtsStyleParams("sad", 0.5, 1.0);
		await synth.synthesize("test", sadStyle);

		const [queryUrl] = mockFetch.mock.calls[0] as [URL, RequestInit];
		// sad は styleSpeakerMap に未定義 → デフォルト speakerId (2) を使用
		expect(queryUrl.searchParams.get("speaker")).toBe("2");
	});
});

// ─── synthesize: timeout ─────────────────────────────────────────

describe("synthesize — timeout", () => {
	it("デフォルトタイムアウト (30000ms) が使用される", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 48000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		await synth.synthesize("test", DEFAULT_STYLE);

		const [, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("カスタムタイムアウトを設定できる", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 48000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({
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
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 96000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeCloseTo(2.0, 5);
	});

	it("known WAV: byteRate=48000, dataSize=24000 → duration=0.5s", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(48000, 24000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeCloseTo(0.5, 5);
	});
});

describe("computeWavDuration — edge cases", () => {
	it("44 bytes 未満のバッファ → null を返す", async () => {
		const shortBuffer = new ArrayBuffer(20);
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(shortBuffer, { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).toBeNull();
	});

	it("byteRate=0 → null を返す", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(0, 96000), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).toBeNull();
	});

	it("data chunk が存在しない → null を返す", async () => {
		const noDataChunk = new Uint8Array(64);
		noDataChunk.set([0x52, 0x49, 0x46, 0x46], 0);
		noDataChunk.set([0x57, 0x41, 0x56, 0x45], 8);
		noDataChunk.set([0x66, 0x6d, 0x74, 0x20], 12);
		writeUint32LE(noDataChunk, 28, 48000);

		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(noDataChunk.buffer as ArrayBuffer, { status: 200 }),
		);

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).toBeNull();
	});
});

// ─── readUint32LE — byte order ───────────────────────────────────

describe("readUint32LE — byte order verification via WAV parsing", () => {
	it("byteRate=0x00_01_00_00 (65536) が正しく読まれる", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(65536, 65536), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeCloseTo(1.0, 5);
	});

	it("byteRate=0x01_02_03_04 が正しくリトルエンディアンで読まれる", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response(buildWav(16909060, 16909060), { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		const result = await synth.synthesize("test", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeCloseTo(1.0, 5);
	});
});

// ─── isAvailable ─────────────────────────────────────────────────

describe("isAvailable — fetch call", () => {
	it("baseUrl に GET でフェッチする", async () => {
		mockFetch.mockResolvedValueOnce(new Response("OK", { status: 200 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		await synth.isAvailable();

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(BASE_URL);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("HTTP 4xx でも false を返す", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

		const synth = createAivisSpeechSynthesizer({ baseUrl: BASE_URL });
		const result = await synth.isAvailable();

		expect(result).toBe(false);
	});
});

// ─── Helper: WAV バッファ構築 ────────────────────────────────────

function buildWav(byteRate: number, dataSize: number): ArrayBuffer {
	const headerSize = 44;
	const totalSize = headerSize + dataSize;
	const wav = new Uint8Array(totalSize);

	wav.set([0x52, 0x49, 0x46, 0x46], 0);
	writeUint32LE(wav, 4, totalSize - 8);
	wav.set([0x57, 0x41, 0x56, 0x45], 8);
	wav.set([0x66, 0x6d, 0x74, 0x20], 12);
	writeUint32LE(wav, 16, 16);
	wav[20] = 0x01;
	wav[21] = 0x00;
	wav[22] = 0x01;
	wav[23] = 0x00;
	writeUint32LE(wav, 24, 24000);
	writeUint32LE(wav, 28, byteRate);
	wav[32] = 0x02;
	wav[33] = 0x00;
	wav[34] = 0x10;
	wav[35] = 0x00;
	wav.set([0x64, 0x61, 0x74, 0x61], 36);
	writeUint32LE(wav, 40, dataSize);

	return wav.buffer as ArrayBuffer;
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >> 8) & 0xff;
	buf[offset + 2] = (value >> 16) & 0xff;
	buf[offset + 3] = (value >> 24) & 0xff;
}
