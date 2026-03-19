import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { TtsSynthesizer } from "@vicissitude/shared/ports";
import { type TtsStyleParams, createTtsStyleParams } from "@vicissitude/shared/tts";
import { createAivisSpeechSynthesizer } from "@vicissitude/tts";

// ─── テスト対象のファクトリ ─────────────────────────────────────
//
// packages/tts が公開する AivisSpeech アダプターを生成する関数。
// ブラックボックステスト: TtsSynthesizer ポートの契約のみ検証する。
// 外部 HTTP 依存は global.fetch をモックして差し替える。

const BASE_URL = "http://localhost:10101";

function synthesizer(config?: {
	baseUrl?: string;
	speakerId?: number;
	timeout?: number;
}): TtsSynthesizer {
	return createAivisSpeechSynthesizer({
		baseUrl: config?.baseUrl ?? BASE_URL,
		speakerId: config?.speakerId,
		timeout: config?.timeout,
	});
}

// ─── fetch モック ───────────────────────────────────────────────

// 最小限の WAV ヘッダー (44 bytes)
const DUMMY_WAV_HEADER = new Uint8Array([
	// "RIFF"
	0x52, 0x49, 0x46, 0x46,
	// chunk size (36 bytes of header + 0 data)
	0x24, 0x00, 0x00, 0x00,
	// "WAVE"
	0x57, 0x41, 0x56, 0x45,
	// "fmt " sub-chunk
	0x66, 0x6d, 0x74, 0x20,
	// sub-chunk size (16)
	0x10, 0x00, 0x00, 0x00,
	// audio format (1 = PCM)
	0x01, 0x00,
	// channels (1)
	0x01, 0x00,
	// sample rate (24000)
	0xc0, 0x5d, 0x00, 0x00,
	// byte rate (48000)
	0x80, 0xbb, 0x00, 0x00,
	// block align (2)
	0x02, 0x00,
	// bits per sample (16)
	0x10, 0x00,
	// "data" sub-chunk
	0x64, 0x61, 0x74, 0x61,
	// data size (0)
	0x00, 0x00, 0x00, 0x00,
]);

// AudioQuery のダミーレスポンス
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

const DEFAULT_STYLE: TtsStyleParams = createTtsStyleParams("happy", 0.7, 1.0);

// ─── synthesize: 正常系 ─────────────────────────────────────────

describe("AivisSpeechSynthesizer — synthesize", () => {
	it("テキストとスタイルを渡して TtsResult を返す", async () => {
		// audio_query
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		// synthesis
		mockFetch.mockResolvedValueOnce(
			new Response(DUMMY_WAV_HEADER.buffer as ArrayBuffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const result = await synthesizer().synthesize("こんにちは", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.audio).toBeInstanceOf(Uint8Array);
		expect(result?.audio.length).toBeGreaterThan(0);
		expect(result?.format).toBe("wav");
		expect(result?.durationSec).toBeGreaterThanOrEqual(0);
	});

	it("返り値の format が 'wav'", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(DUMMY_WAV_HEADER.buffer as ArrayBuffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const result = await synthesizer().synthesize("テスト", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.format).toBe("wav");
	});

	it("durationSec が正の数または 0", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(DUMMY_WAV_HEADER.buffer as ArrayBuffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const result = await synthesizer().synthesize("テスト", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeGreaterThanOrEqual(0);
	});
});

// ─── synthesize: エラー系 ───────────────────────────────────────

describe("AivisSpeechSynthesizer — synthesize errors", () => {
	it("audio_query で HTTP 5xx エラー時に null を返す", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

		const result = await synthesizer().synthesize("こんにちは", DEFAULT_STYLE);

		expect(result).toBeNull();
	});

	it("synthesis で HTTP 5xx エラー時に null を返す", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

		const result = await synthesizer().synthesize("こんにちは", DEFAULT_STYLE);

		expect(result).toBeNull();
	});

	it("ネットワーク不達時に null を返す", async () => {
		mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

		const result = await synthesizer().synthesize("こんにちは", DEFAULT_STYLE);

		expect(result).toBeNull();
	});
});

// ─── isAvailable ────────────────────────────────────────────────

describe("AivisSpeechSynthesizer — isAvailable", () => {
	it("ヘルスチェック成功時に true を返す", async () => {
		mockFetch.mockResolvedValueOnce(new Response("OK", { status: 200 }));

		const available = await synthesizer().isAvailable();

		expect(available).toBe(true);
	});

	it("ヘルスチェック失敗時 (5xx) に false を返す", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));

		const available = await synthesizer().isAvailable();

		expect(available).toBe(false);
	});

	it("ネットワーク不達時に false を返す", async () => {
		mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

		const available = await synthesizer().isAvailable();

		expect(available).toBe(false);
	});
});
