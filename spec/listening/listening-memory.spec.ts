/* oxlint-disable require-await -- mock implementations */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { ListeningRecord, TrackLlmPort } from "@vicissitude/listening/types";
import { MemoryStorage } from "@vicissitude/memory/storage";
import { HUA_SELF_SUBJECT } from "@vicissitude/shared/namespace";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

// --- fixtures ---

function makeTrack(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
	return {
		id: overrides.id ?? "t-1",
		name: overrides.name ?? "夜に駆ける",
		artistName: overrides.artistName ?? "YOASOBI",
		artistId: overrides.artistId ?? "a-1",
		albumName: overrides.albumName ?? "THE BOOK",
		genres: overrides.genres ?? ["j-pop"],
		popularity: overrides.popularity ?? 85,
		releaseDate: overrides.releaseDate ?? "2020-12-15",
		albumArtUrl: overrides.albumArtUrl ?? "https://example.com/art.jpg",
	};
}

function makeRecord(overrides: Partial<ListeningRecord> = {}): ListeningRecord {
	return {
		track: overrides.track ?? makeTrack(),
		lyrics: overrides.lyrics ?? "歌詞サンプル",
		understanding: overrides.understanding ?? {
			vocalGender: "female",
			tieIn: null,
			moodThemes: ["melancholic"],
			summary: "切ないJ-POP",
		},
		impression: overrides.impression ?? "歌詞が切なくて好き",
		listenedAt: overrides.listenedAt ?? new Date("2026-04-06T12:00:00Z"),
	};
}

function createStubLlm(embedding: number[] = [0.1, 0.2, 0.3]): TrackLlmPort {
	return {
		inferUnderstanding: async () => ({
			vocalGender: "unknown",
			tieIn: null,
			moodThemes: [],
			summary: "",
		}),
		generateImpression: async () => "",
		embed: async () => embedding,
	};
}

describe("ListeningMemory — Memory 保存の契約", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	it("saveListening で SemanticFact が永続化される", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const memory = new ListeningMemory(storage, createStubLlm());

		await memory.saveListening(makeRecord());

		const facts = await storage.getFacts(HUA_SELF_SUBJECT);
		expect(facts).toHaveLength(1);
	});

	it("保存される SemanticFact の category は 'experience' である", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const memory = new ListeningMemory(storage, createStubLlm());

		await memory.saveListening(makeRecord());

		const facts = await storage.getFacts(HUA_SELF_SUBJECT);
		expect(facts[0]?.category).toBe("experience");
	});

	it("保存される SemanticFact の userId は HUA_SELF_SUBJECT (internal namespace) である", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const memory = new ListeningMemory(storage, createStubLlm());

		await memory.saveListening(makeRecord());

		const facts = await storage.getFacts(HUA_SELF_SUBJECT);
		expect(facts[0]?.userId).toBe(HUA_SELF_SUBJECT);
	});

	it("fact 本文には曲名・アーティスト名・感想が含まれる", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const memory = new ListeningMemory(storage, createStubLlm());

		await memory.saveListening(
			makeRecord({
				track: makeTrack({ name: "群青", artistName: "YOASOBI" }),
				impression: "爽やかで好き",
			}),
		);

		const facts = await storage.getFacts(HUA_SELF_SUBJECT);
		const fact = facts[0];
		expect(fact).toBeDefined();
		expect(fact?.fact).toContain("群青");
		expect(fact?.fact).toContain("YOASOBI");
		expect(fact?.fact).toContain("爽やかで好き");
	});

	it("keywords に曲名・アーティスト名が含まれる", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const memory = new ListeningMemory(storage, createStubLlm());

		await memory.saveListening(
			makeRecord({
				track: makeTrack({ name: "夜に駆ける", artistName: "YOASOBI" }),
			}),
		);

		const facts = await storage.getFacts(HUA_SELF_SUBJECT);
		expect(facts[0]?.keywords).toContain("夜に駆ける");
		expect(facts[0]?.keywords).toContain("YOASOBI");
	});

	it("memory_get_facts の仕組みで取得できる（既存 getFacts 互換）", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const memory = new ListeningMemory(storage, createStubLlm());

		await memory.saveListening(makeRecord({ track: makeTrack({ name: "曲A" }) }));
		await memory.saveListening(makeRecord({ track: makeTrack({ id: "t-2", name: "曲B" }) }));

		const experiences = await storage.getFactsByCategory(HUA_SELF_SUBJECT, "experience");
		expect(experiences).toHaveLength(2);
	});

	it("memory_retrieve の仕組み（keyword 検索）で引き出せる", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const memory = new ListeningMemory(storage, createStubLlm());

		await memory.saveListening(
			makeRecord({ track: makeTrack({ name: "夜に駆ける", artistName: "YOASOBI" }) }),
		);

		const results = await storage.searchFacts(HUA_SELF_SUBJECT, "YOASOBI", 10);
		expect(results.length).toBeGreaterThan(0);
	});

	it("LLM.embed が呼ばれ、embedding が SemanticFact に保存される", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const customEmbedding = [0.5, 0.4, 0.3];
		const memory = new ListeningMemory(storage, createStubLlm(customEmbedding));

		await memory.saveListening(makeRecord());

		const facts = await storage.getFacts(HUA_SELF_SUBJECT);
		expect(facts[0]?.embedding).toEqual(customEmbedding);
	});

	it("listenedAt が validAt / createdAt に反映される", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const memory = new ListeningMemory(storage, createStubLlm());
		const listenedAt = new Date("2026-04-06T12:00:00Z");

		await memory.saveListening(makeRecord({ listenedAt }));

		const facts = await storage.getFacts(HUA_SELF_SUBJECT);
		expect(facts[0]?.validAt.getTime()).toBe(listenedAt.getTime());
	});
});
