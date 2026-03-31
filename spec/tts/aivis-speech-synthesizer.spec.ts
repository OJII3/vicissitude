import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { TtsSynthesizer } from "@vicissitude/shared/ports";
import { createMockLogger } from "@vicissitude/shared/test-helpers";
import { type TtsStyleParams, createTtsStyleParams } from "@vicissitude/shared/tts";
import type { Logger } from "@vicissitude/shared/types";
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
	logger?: Logger;
}): TtsSynthesizer {
	return createAivisSpeechSynthesizer({
		baseUrl: config?.baseUrl ?? BASE_URL,
		speakerId: config?.speakerId,
		timeout: config?.timeout,
		logger: config?.logger,
	});
}

// ─── fetch モック ───────────────────────────────────────────────

// data chunk size が 0 の WAV（durationSec が 0 になる不正な WAV）
const ZERO_LENGTH_WAV = new Uint8Array([
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

// 有効な WAV データ（44 bytes ヘッダー + 100 bytes ダミーデータ）
// data size = 100, chunk size = 36 + 100 = 136 (0x88)
// byte rate = 48000 → durationSec = 100 / 48000 ≈ 0.00208
const VALID_WAV = (() => {
	const dataSize = 100;
	const header = new Uint8Array([
		// "RIFF"
		0x52, 0x49, 0x46, 0x46,
		// chunk size (36 + dataSize = 136 = 0x88)
		0x88, 0x00, 0x00, 0x00,
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
		// data size (100 = 0x64)
		0x64, 0x00, 0x00, 0x00,
	]);
	const wav = new Uint8Array(44 + dataSize);
	wav.set(header);
	// ダミー音声データ（0 埋め）は既に初期化済み
	return wav;
})();

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
			new Response(VALID_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const result = await synthesizer().synthesize("こんにちは", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.audio).toBeInstanceOf(Uint8Array);
		expect(result?.audio.length).toBeGreaterThan(0);
		expect(result?.format).toBe("wav");
		expect(result?.durationSec).toBeGreaterThan(0);
	});

	it("返り値の format が 'wav'", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(VALID_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const result = await synthesizer().synthesize("テスト", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.format).toBe("wav");
	});

	it("durationSec が正の数", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(VALID_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const result = await synthesizer().synthesize("テスト", DEFAULT_STYLE);

		expect(result).not.toBeNull();
		expect(result?.durationSec).toBeGreaterThan(0);
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

	it("WAV の data chunk size が 0 の場合、synthesize は null を返す", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(ZERO_LENGTH_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const result = await synthesizer().synthesize("こんにちは", DEFAULT_STYLE);

		expect(result).toBeNull();
	});
});

// ─── synthesize: AbortSignal ─────────────────────────────────────

describe("AivisSpeechSynthesizer — synthesize abort", () => {
	it("abort 済み signal を渡した場合に null を返す", async () => {
		const ac = new AbortController();
		ac.abort();

		// abort 済み signal で fetch を呼ぶと AbortError になるのでモックで再現
		mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));

		const result = await synthesizer().synthesize("こんにちは", DEFAULT_STYLE, ac.signal);

		expect(result).toBeNull();
	});

	it("fetch 中に signal が abort された場合に null を返す", async () => {
		const ac = new AbortController();

		// audio_query は成功
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		// synthesis で abort エラーを発生させる
		mockFetch.mockImplementationOnce(() => {
			ac.abort();
			return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
		});

		const result = await synthesizer().synthesize("こんにちは", DEFAULT_STYLE, ac.signal);

		expect(result).toBeNull();
	});
});

// ─── synthesize: logger DI ──────────────────────────────────────

describe("AivisSpeechSynthesizer — logger DI", () => {
	it("エラー発生時にカスタム logger.warn が呼ばれる", async () => {
		const logger = createMockLogger();
		mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

		await synthesizer({ logger }).synthesize("こんにちは", DEFAULT_STYLE);

		expect(logger.warn).toHaveBeenCalled();
	});

	it("logger 未指定でもエラー時に例外をスローしない", async () => {
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
