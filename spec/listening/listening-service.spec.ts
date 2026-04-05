/* oxlint-disable require-await -- mock implementations */
import { describe, expect, it } from "bun:test";

import type {
	ListeningMemoryPort,
	ListeningRecord,
	LyricsPort,
	TrackLlmPort,
	TrackUnderstanding,
} from "@vicissitude/listening/types";
import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

// --- fixtures ---

function makeTrack(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
	return {
		id: overrides.id ?? "track-1",
		name: overrides.name ?? "夜に駆ける",
		artistName: overrides.artistName ?? "YOASOBI",
		artistId: overrides.artistId ?? "artist-1",
		albumName: overrides.albumName ?? "THE BOOK",
		genres: overrides.genres ?? ["j-pop"],
		popularity: overrides.popularity ?? 85,
		releaseDate: overrides.releaseDate ?? "2020-12-15",
		albumArtUrl: overrides.albumArtUrl ?? "https://example.com/art.jpg",
	};
}

function makeUnderstanding(overrides: Partial<TrackUnderstanding> = {}): TrackUnderstanding {
	return {
		vocalGender: overrides.vocalGender ?? "female",
		tieIn: overrides.tieIn ?? null,
		moodThemes: overrides.moodThemes ?? ["melancholic"],
		summary: overrides.summary ?? "切ない雰囲気のJ-POP",
	};
}

// --- mock ports ---

function createMockLyrics(lyrics: string | null = "歌詞のサンプル"): LyricsPort {
	return {
		fetchLyrics: async () => lyrics,
	};
}

function createFailingLyrics(error = new Error("Genius API down")): LyricsPort {
	return {
		fetchLyrics: async () => {
			throw error;
		},
	};
}

function createMockTrackLlm(
	overrides: {
		understanding?: TrackUnderstanding;
		impression?: string;
		embedding?: number[];
	} = {},
): TrackLlmPort {
	return {
		inferUnderstanding: async () => overrides.understanding ?? makeUnderstanding(),
		generateImpression: async () => overrides.impression ?? "歌詞が切なくて好き",
		embed: async () => overrides.embedding ?? [0.1, 0.2, 0.3],
	};
}

function createRecordingMemory(): {
	port: ListeningMemoryPort;
	saved: ListeningRecord[];
} {
	const saved: ListeningRecord[] = [];
	const port: ListeningMemoryPort = {
		saveListening: async (record) => {
			saved.push(record);
			return {
				id: `fact-${saved.length}`,
				userId: "hua:self",
				category: "experience",
				fact: `${record.track.artistName} の『${record.track.name}』を聴いた。${record.impression}`,
				keywords: [record.track.name, record.track.artistName],
				sourceEpisodicIds: [],
				embedding: [0.1, 0.2, 0.3],
				validAt: record.listenedAt,
				invalidAt: null,
				createdAt: record.listenedAt,
			} satisfies SemanticFact;
		},
	};
	return { port, saved };
}

// --- tests ---

describe("ListeningService.listenTo", () => {
	it("楽曲を聴いて歌詞・理解・感想・listenedAt を含む ListeningRecord を返す", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port } = createRecordingMemory();
		const service = new ListeningService(
			createMockLyrics("夜に駆ける〜"),
			createMockTrackLlm({ impression: "疾走感があって好き" }),
			port,
		);

		const track = makeTrack();
		const record = await service.listenTo(track);

		expect(record.track).toEqual(track);
		expect(record.lyrics).toBe("夜に駆ける〜");
		expect(record.impression).toBe("疾走感があって好き");
		expect(record.understanding).toBeDefined();
		expect(record.listenedAt).toBeInstanceOf(Date);
	});

	it("歌詞が取得できない楽曲（Genius に存在しない）でも正常に処理が完了する", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port, saved } = createRecordingMemory();
		const service = new ListeningService(
			createMockLyrics(null),
			createMockTrackLlm(),
			port,
		);

		const record = await service.listenTo(makeTrack());

		expect(record.lyrics).toBeNull();
		expect(saved).toHaveLength(1);
	});

	it("Genius API 呼び出しが失敗しても listenTo は成功し、lyrics は null になる", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port, saved } = createRecordingMemory();
		const service = new ListeningService(
			createFailingLyrics(),
			createMockTrackLlm(),
			port,
		);

		const record = await service.listenTo(makeTrack());

		expect(record.lyrics).toBeNull();
		expect(saved).toHaveLength(1);
	});

	it("聴取した楽曲を ListeningMemoryPort 経由で Memory に保存する", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port, saved } = createRecordingMemory();
		const service = new ListeningService(
			createMockLyrics(),
			createMockTrackLlm(),
			port,
		);

		const track = makeTrack({ name: "群青", artistName: "YOASOBI" });
		await service.listenTo(track);

		expect(saved).toHaveLength(1);
		expect(saved[0]?.track.id).toBe(track.id);
		expect(saved[0]?.track.name).toBe("群青");
	});

	it("LLM には曲名・アーティスト・歌詞・Spotify メタ情報が渡される", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port } = createRecordingMemory();

		let understandingInput: unknown = null;
		let impressionInput: unknown = null;
		const llm: TrackLlmPort = {
			inferUnderstanding: async (input) => {
				understandingInput = input;
				return makeUnderstanding();
			},
			generateImpression: async (input) => {
				impressionInput = input;
				return "いい感じ";
			},
			embed: async () => [0.1, 0.2, 0.3],
		};

		const service = new ListeningService(createMockLyrics("歌詞A"), llm, port);
		await service.listenTo(
			makeTrack({ name: "曲名X", artistName: "アーティストY", genres: ["rock"] }),
		);

		expect(understandingInput).toMatchObject({
			title: "曲名X",
			artistName: "アーティストY",
			lyrics: "歌詞A",
		});
		expect(impressionInput).toBeDefined();
	});

	it("歌詞が null の場合でも LLM は lyrics=null を受け取り understanding を生成できる", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port } = createRecordingMemory();

		const lyricsCalls: Array<string | null> = [];
		const llm: TrackLlmPort = {
			inferUnderstanding: async (input) => {
				lyricsCalls.push((input as { lyrics: string | null }).lyrics);
				return makeUnderstanding();
			},
			generateImpression: async () => "感想",
			embed: async () => [0.1, 0.2, 0.3],
		};

		const service = new ListeningService(createMockLyrics(null), llm, port);
		await service.listenTo(makeTrack());

		expect(lyricsCalls).toHaveLength(1);
		expect(lyricsCalls[0]).toBeNull();
	});

	it("TrackUnderstanding は vocalGender / tieIn / moodThemes / summary を含む", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port } = createRecordingMemory();
		const understanding = makeUnderstanding({
			vocalGender: "female",
			tieIn: "anime theme: Beastars OP",
			moodThemes: ["dark", "dramatic"],
			summary: "ダークで劇的なロック",
		});

		const service = new ListeningService(
			createMockLyrics(),
			createMockTrackLlm({ understanding }),
			port,
		);

		const record = await service.listenTo(makeTrack());

		expect(record.understanding.vocalGender).toBe("female");
		expect(record.understanding.tieIn).toBe("anime theme: Beastars OP");
		expect(record.understanding.moodThemes).toEqual(["dark", "dramatic"]);
		expect(record.understanding.summary).toBe("ダークで劇的なロック");
	});

	it("tieIn が存在しない楽曲では null を許容する", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port } = createRecordingMemory();
		const service = new ListeningService(
			createMockLyrics(),
			createMockTrackLlm({ understanding: makeUnderstanding({ tieIn: null }) }),
			port,
		);

		const record = await service.listenTo(makeTrack());

		expect(record.understanding.tieIn).toBeNull();
	});

	it("vocalGender は male / female / mixed / unknown のいずれか", async () => {
		const { ListeningService } = await import("@vicissitude/listening/listening-service");
		const { port } = createRecordingMemory();
		const service = new ListeningService(
			createMockLyrics(),
			createMockTrackLlm({ understanding: makeUnderstanding({ vocalGender: "unknown" }) }),
			port,
		);

		const record = await service.listenTo(makeTrack());

		expect(["male", "female", "mixed", "unknown"]).toContain(record.understanding.vocalGender);
	});
});
