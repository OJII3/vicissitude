/* oxlint-disable require-await -- mock implementations */
import { describe, expect, it } from "bun:test";

import type { ListeningFactStore } from "@vicissitude/listening/listening-memory";
import type { ListeningRecord } from "@vicissitude/listening/types";
import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
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
		impression: overrides.impression ?? "歌詞が切なくて好き",
		listenedAt: overrides.listenedAt ?? new Date("2026-04-06T12:00:00Z"),
	};
}

interface StubEmbedder {
	embed(text: string): Promise<number[]>;
}

function createStubEmbedder(embedding: number[] = [0.1, 0.2, 0.3]): StubEmbedder {
	return { embed: async () => embedding };
}

interface CapturedFact {
	userId: string;
	fact: SemanticFact;
}

interface CapturingFactStore extends ListeningFactStore {
	saved: CapturedFact[];
}

function createCapturingFactStore(): CapturingFactStore {
	const saved: CapturedFact[] = [];
	return {
		saved,
		saveFact: async (userId, fact) => {
			saved.push({ userId, fact });
		},
	};
}

describe("ListeningMemory — Memory 保存の契約", () => {
	it("saveListening は saveFact だけの port に SemanticFact を渡す", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const storage = createCapturingFactStore();
		const memory = new ListeningMemory(storage, createStubEmbedder());

		await memory.saveListening(makeRecord());

		expect(storage.saved).toHaveLength(1);
	});

	it("保存される SemanticFact の category は 'experience' である", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const storage = createCapturingFactStore();
		const memory = new ListeningMemory(storage, createStubEmbedder());

		await memory.saveListening(makeRecord());

		expect(storage.saved[0]?.fact.category).toBe("experience");
	});

	it("保存される SemanticFact の userId は HUA_SELF_SUBJECT (internal namespace) である", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const storage = createCapturingFactStore();
		const memory = new ListeningMemory(storage, createStubEmbedder());

		await memory.saveListening(makeRecord());

		expect(storage.saved[0]?.userId).toBe(HUA_SELF_SUBJECT);
		expect(storage.saved[0]?.fact.userId).toBe(HUA_SELF_SUBJECT);
	});

	it("fact 本文には曲名・アーティスト名・感想が含まれる", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const storage = createCapturingFactStore();
		const memory = new ListeningMemory(storage, createStubEmbedder());

		await memory.saveListening(
			makeRecord({
				track: makeTrack({ name: "群青", artistName: "YOASOBI" }),
				impression: "爽やかで好き",
			}),
		);

		const fact = storage.saved[0]?.fact;
		expect(fact).toBeDefined();
		expect(fact?.fact).toContain("群青");
		expect(fact?.fact).toContain("YOASOBI");
		expect(fact?.fact).toContain("爽やかで好き");
	});

	it("keywords に曲名・アーティスト名が含まれる", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const storage = createCapturingFactStore();
		const memory = new ListeningMemory(storage, createStubEmbedder());

		await memory.saveListening(
			makeRecord({
				track: makeTrack({ name: "夜に駆ける", artistName: "YOASOBI" }),
			}),
		);

		expect(storage.saved[0]?.fact.keywords).toContain("夜に駆ける");
		expect(storage.saved[0]?.fact.keywords).toContain("YOASOBI");
	});

	it("embedder.embed が呼ばれ、embedding が SemanticFact に保存される", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const storage = createCapturingFactStore();
		const customEmbedding = [0.5, 0.4, 0.3];
		const memory = new ListeningMemory(storage, createStubEmbedder(customEmbedding));

		await memory.saveListening(makeRecord());

		expect(storage.saved[0]?.fact.embedding).toEqual(customEmbedding);
	});

	it("listenedAt が validAt / createdAt に反映される", async () => {
		const { ListeningMemory } = await import("@vicissitude/listening/listening-memory");
		const storage = createCapturingFactStore();
		const memory = new ListeningMemory(storage, createStubEmbedder());
		const listenedAt = new Date("2026-04-06T12:00:00Z");

		await memory.saveListening(makeRecord({ listenedAt }));

		expect(storage.saved[0]?.fact.validAt.getTime()).toBe(listenedAt.getTime());
		expect(storage.saved[0]?.fact.createdAt.getTime()).toBe(listenedAt.getTime());
	});
});
