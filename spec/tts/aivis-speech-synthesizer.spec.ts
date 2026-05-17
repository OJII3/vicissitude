import { beforeEach, describe, expect, it, mock } from "bun:test";

import { createMockLogger } from "@vicissitude/shared/test-helpers";
import { type TtsStyleParams, createTtsStyleParams } from "@vicissitude/shared/tts";
import type { Logger } from "@vicissitude/shared/types";
import {
	AivisSpeechSynthesizer,
	type AivisFetch,
	type AivisStyleConfigMap,
} from "@vicissitude/tts";

// ─── テスト対象のクラス ─────────────────────────────────────────
//
// packages/tts が公開する AivisSpeech アダプター。
// ブラックボックステスト: TtsSynthesizer ポートの契約のみ検証する。
// 外部 HTTP 依存は注入した fetch で差し替える。

const BASE_URL = "http://localhost:10101";

function synthesizer(config?: {
	baseUrl?: string;
	fetch?: ReturnType<typeof mock>;
	speakerId?: number;
	styleConfigs?: AivisStyleConfigMap;
	timeout?: number;
	logger?: Logger;
}): AivisSpeechSynthesizer {
	return new AivisSpeechSynthesizer({
		baseUrl: config?.baseUrl ?? BASE_URL,
		fetch: (config?.fetch ?? mockFetch) as unknown as AivisFetch,
		speakerId: config?.speakerId,
		styleConfigs: config?.styleConfigs,
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

let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
	mockFetch = mock();
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

	it("注入された fetch を使い、globalThis.fetch には依存しない", async () => {
		const injectedFetch = mock();
		injectedFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		injectedFetch.mockResolvedValueOnce(
			new Response(VALID_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() => {
			throw new Error("global fetch should not be used");
		}) as unknown as typeof fetch;

		try {
			const result = await synthesizer({ fetch: injectedFetch }).synthesize(
				"こんにちは",
				DEFAULT_STYLE,
			);

			expect(result).not.toBeNull();
			expect(injectedFetch).toHaveBeenCalledTimes(2);
		} finally {
			globalThis.fetch = originalFetch;
		}
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

// ─── synthesize: style application ──────────────────────────────

describe("AivisSpeechSynthesizer — style application", () => {
	it("styleConfigs の speakerId を audio_query と synthesis の speaker に適用する", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(VALID_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		await synthesizer({
			speakerId: 0,
			styleConfigs: {
				happy: { speakerId: 7 },
			},
		}).synthesize("こんにちは", DEFAULT_STYLE);

		const [queryUrl] = mockFetch.mock.calls[0] as [URL, RequestInit];
		const [synthUrl] = mockFetch.mock.calls[1] as [URL, RequestInit];
		expect(queryUrl.searchParams.get("speaker")).toBe("7");
		expect(synthUrl.searchParams.get("speaker")).toBe("7");
	});

	it("styleWeight に応じて style 別 audioQuery 設定を線形に反映する", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					speedScale: 1.0,
					pitchScale: 0.0,
					intonationScale: 1.0,
					volumeScale: 1.0,
				}),
				{ status: 200 },
			),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(VALID_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);
		const weightedStyle = createTtsStyleParams("happy", 0.5, 1.2);

		await synthesizer({
			styleConfigs: {
				happy: {
					audioQuery: {
						pitchScale: 0.4,
						intonationScale: 1.8,
						volumeScale: 1.2,
					},
				},
			},
		}).synthesize("こんにちは", weightedStyle);

		const [, synthInit] = mockFetch.mock.calls[1] as [URL, RequestInit];
		const body = JSON.parse(synthInit.body as string);
		expect(body.speedScale).toBe(1.2);
		expect(body.pitchScale).toBeCloseTo(0.2);
		expect(body.intonationScale).toBeCloseTo(1.4);
		expect(body.volumeScale).toBeCloseTo(1.1);
	});

	it("styleWeight が 0 の場合、style 別 audioQuery 設定は反映せず speed のみ適用する", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					speedScale: 1.0,
					pitchScale: 0.0,
					intonationScale: 1.0,
				}),
				{ status: 200 },
			),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(VALID_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);
		const unweightedStyle = createTtsStyleParams("happy", 0, 0.9);

		await synthesizer({
			styleConfigs: {
				happy: {
					audioQuery: {
						pitchScale: 0.4,
						intonationScale: 1.8,
					},
				},
			},
		}).synthesize("こんにちは", unweightedStyle);

		const [, synthInit] = mockFetch.mock.calls[1] as [URL, RequestInit];
		const body = JSON.parse(synthInit.body as string);
		expect(body.speedScale).toBe(0.9);
		expect(body.pitchScale).toBe(0.0);
		expect(body.intonationScale).toBe(1.0);
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

// ─── synthesizeWithReason: explicit failures ────────────────────

describe("AivisSpeechSynthesizer — synthesizeWithReason", () => {
	it("成功時は ok: true と TtsResult を返す", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(VALID_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const outcome = await synthesizer().synthesizeWithReason("こんにちは", DEFAULT_STYLE);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.result.format).toBe("wav");
		expect(outcome.result.durationSec).toBeGreaterThan(0);
	});

	it("audio_query の HTTP エラー理由を返す", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

		const outcome = await synthesizer().synthesizeWithReason("こんにちは", DEFAULT_STYLE);

		expect(outcome).toMatchObject({
			ok: false,
			reason: "audio_query_http_error",
			stage: "audio_query",
			status: 500,
		});
	});

	it("audio_query の JSON 不正理由を返す", async () => {
		mockFetch.mockResolvedValueOnce(new Response("not json", { status: 200 }));

		const outcome = await synthesizer().synthesizeWithReason("こんにちは", DEFAULT_STYLE);

		expect(outcome).toMatchObject({
			ok: false,
			reason: "audio_query_invalid_response",
			stage: "audio_query",
		});
	});

	it("synthesis の HTTP エラー理由を返す", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

		const outcome = await synthesizer().synthesizeWithReason("こんにちは", DEFAULT_STYLE);

		expect(outcome).toMatchObject({
			ok: false,
			reason: "synthesis_http_error",
			stage: "synthesis",
			status: 500,
		});
	});

	it("不正な WAV の理由を返す", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify(DUMMY_AUDIO_QUERY), { status: 200 }),
		);
		mockFetch.mockResolvedValueOnce(
			new Response(ZERO_LENGTH_WAV.buffer, {
				status: 200,
				headers: { "Content-Type": "audio/wav" },
			}),
		);

		const outcome = await synthesizer().synthesizeWithReason("こんにちは", DEFAULT_STYLE);

		expect(outcome).toMatchObject({
			ok: false,
			reason: "invalid_audio",
			stage: "wav_validation",
		});
	});

	it("AbortError の理由を返す", async () => {
		const ac = new AbortController();
		ac.abort();
		mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));

		const outcome = await synthesizer().synthesizeWithReason(
			"こんにちは",
			DEFAULT_STYLE,
			ac.signal,
		);

		expect(outcome).toMatchObject({
			ok: false,
			reason: "aborted",
		});
	});

	it("ネットワーク不達の理由を返す", async () => {
		mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

		const outcome = await synthesizer().synthesizeWithReason("こんにちは", DEFAULT_STYLE);

		expect(outcome).toMatchObject({
			ok: false,
			reason: "network_error",
			message: "fetch failed",
		});
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

	it("AbortError 発生時に logger.warn が呼ばれない", async () => {
		const logger = createMockLogger();
		mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));

		await synthesizer({ logger }).synthesize("こんにちは", DEFAULT_STYLE);

		expect(logger.warn).not.toHaveBeenCalled();
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
