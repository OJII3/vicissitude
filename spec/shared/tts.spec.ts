import { describe, expect, it } from "bun:test";

import { createEmotion, NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type { EmotionToTtsStyleMapper, TtsSynthesizer } from "@vicissitude/shared/ports";
import {
	type TtsStyle,
	TtsStyleParamsSchema,
	TtsStyleSchema,
	createTtsStyleParams,
	NEUTRAL_TTS_STYLE,
} from "@vicissitude/shared/tts";

// ─── TtsStyle ───────────────────────────────────────────────────

describe("TtsStyleSchema", () => {
	const validStyles: TtsStyle[] = [
		"neutral",
		"happy",
		"sad",
		"angry",
		"fear",
		"surprised",
		"relaxed",
	];

	it("accepts all 7 valid styles", () => {
		for (const style of validStyles) {
			expect(TtsStyleSchema.parse(style)).toBe(style);
		}
	});

	it("rejects invalid style labels", () => {
		expect(() => TtsStyleSchema.parse("excited")).toThrow();
		expect(() => TtsStyleSchema.parse("")).toThrow();
		expect(() => TtsStyleSchema.parse(42)).toThrow();
	});
});

// ─── TtsStyleParams ─────────────────────────────────────────────

describe("TtsStyleParamsSchema", () => {
	it("accepts valid params", () => {
		const result = TtsStyleParamsSchema.parse({
			style: "happy",
			styleWeight: 0.8,
			speed: 1.1,
		});
		expect(result.style).toBe("happy");
		expect(result.styleWeight).toBeCloseTo(0.8);
		expect(result.speed).toBeCloseTo(1.1);
	});

	it("accepts styleWeight at boundaries (0 and 1)", () => {
		expect(
			TtsStyleParamsSchema.parse({ style: "neutral", styleWeight: 0, speed: 1.0 }).styleWeight,
		).toBe(0);
		expect(
			TtsStyleParamsSchema.parse({ style: "neutral", styleWeight: 1, speed: 1.0 }).styleWeight,
		).toBe(1);
	});

	it("rejects styleWeight outside [0, 1]", () => {
		expect(() =>
			TtsStyleParamsSchema.parse({ style: "happy", styleWeight: -0.1, speed: 1.0 }),
		).toThrow();
		expect(() =>
			TtsStyleParamsSchema.parse({ style: "happy", styleWeight: 1.1, speed: 1.0 }),
		).toThrow();
	});

	it("accepts speed at boundaries (0.5 and 2.0)", () => {
		expect(
			TtsStyleParamsSchema.parse({ style: "neutral", styleWeight: 0.5, speed: 0.5 }).speed,
		).toBe(0.5);
		expect(
			TtsStyleParamsSchema.parse({ style: "neutral", styleWeight: 0.5, speed: 2.0 }).speed,
		).toBe(2.0);
	});

	it("rejects speed outside [0.5, 2.0]", () => {
		expect(() =>
			TtsStyleParamsSchema.parse({ style: "happy", styleWeight: 0.5, speed: 0.4 }),
		).toThrow();
		expect(() =>
			TtsStyleParamsSchema.parse({ style: "happy", styleWeight: 0.5, speed: 2.1 }),
		).toThrow();
	});

	it("rejects invalid style label", () => {
		expect(() =>
			TtsStyleParamsSchema.parse({ style: "unknown", styleWeight: 0.5, speed: 1.0 }),
		).toThrow();
	});

	it("rejects missing fields", () => {
		expect(() => TtsStyleParamsSchema.parse({ style: "happy" })).toThrow();
		expect(() => TtsStyleParamsSchema.parse({})).toThrow();
	});
});

// ─── createTtsStyleParams ───────────────────────────────────────

describe("createTtsStyleParams", () => {
	it("creates params with given values", () => {
		const p = createTtsStyleParams("happy", 0.8, 1.2);
		expect(p.style).toBe("happy");
		expect(p.styleWeight).toBeCloseTo(0.8);
		expect(p.speed).toBeCloseTo(1.2);
	});

	it("defaults speed to 1.0 when omitted", () => {
		const p = createTtsStyleParams("sad", 0.6);
		expect(p.speed).toBe(1.0);
	});

	it("validates via schema (rejects invalid)", () => {
		expect(() => createTtsStyleParams("happy", 1.5)).toThrow();
		expect(() => createTtsStyleParams("happy", 0.5, 3.0)).toThrow();
	});
});

// ─── NEUTRAL_TTS_STYLE ─────────────────────────────────────────

describe("NEUTRAL_TTS_STYLE", () => {
	it("has neutral style with zero weight and default speed", () => {
		expect(NEUTRAL_TTS_STYLE.style).toBe("neutral");
		expect(NEUTRAL_TTS_STYLE.styleWeight).toBe(0);
		expect(NEUTRAL_TTS_STYLE.speed).toBe(1.0);
	});

	it("is frozen (immutable)", () => {
		expect(Object.isFrozen(NEUTRAL_TTS_STYLE)).toBe(true);
	});
});

// ─── EmotionToTtsStyleMapper (type contract) ────────────────────

describe("EmotionToTtsStyleMapper", () => {
	it("defines a mapToStyle method that accepts Emotion and returns TtsStyleParams", () => {
		const stubMapper: EmotionToTtsStyleMapper = {
			mapToStyle(_emotion) {
				return createTtsStyleParams("happy", 0.8, 1.1);
			},
		};

		const result = stubMapper.mapToStyle(createEmotion(0.8, 0.5, 0.2));
		expect(result.style).toBe("happy");
		expect(result.styleWeight).toBeCloseTo(0.8);
		expect(result.speed).toBeCloseTo(1.1);
	});

	it("returns neutral style for neutral emotion", () => {
		const stubMapper: EmotionToTtsStyleMapper = {
			mapToStyle(_emotion) {
				return NEUTRAL_TTS_STYLE;
			},
		};

		const result = stubMapper.mapToStyle(NEUTRAL_EMOTION);
		expect(result.style).toBe("neutral");
		expect(result.styleWeight).toBe(0);
	});
});

// ─── TtsSynthesizer (type contract) ─────────────────────────────

describe("TtsSynthesizer", () => {
	it("defines synthesize that returns TtsResult on success", async () => {
		// RIFF header stub
		const stubAudio = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
		const stubSynthesizer: TtsSynthesizer = {
			synthesize(_text, _style) {
				return Promise.resolve({
					audio: stubAudio,
					format: "wav" as const,
					durationSec: 1.5,
				});
			},
			isAvailable() {
				return Promise.resolve(true);
			},
		};

		const result = await stubSynthesizer.synthesize(
			"こんにちは",
			createTtsStyleParams("happy", 0.8),
		);
		expect(result).not.toBeNull();
		expect(result?.format).toBe("wav");
		expect(result?.durationSec).toBeCloseTo(1.5);
		expect(result?.audio).toBeInstanceOf(Uint8Array);
	});

	it("defines synthesize that returns null when TTS is unavailable (graceful degradation)", async () => {
		const stubSynthesizer: TtsSynthesizer = {
			synthesize(_text, _style) {
				return Promise.resolve(null);
			},
			isAvailable() {
				return Promise.resolve(false);
			},
		};

		const result = await stubSynthesizer.synthesize(
			"こんにちは",
			createTtsStyleParams("neutral", 0),
		);
		expect(result).toBeNull();
	});

	it("defines isAvailable that returns availability status", async () => {
		const available: TtsSynthesizer = {
			synthesize() {
				return Promise.resolve(null);
			},
			isAvailable() {
				return Promise.resolve(true);
			},
		};

		const unavailable: TtsSynthesizer = {
			synthesize() {
				return Promise.resolve(null);
			},
			isAvailable() {
				return Promise.resolve(false);
			},
		};

		expect(await available.isAvailable()).toBe(true);
		expect(await unavailable.isAvailable()).toBe(false);
	});
});
