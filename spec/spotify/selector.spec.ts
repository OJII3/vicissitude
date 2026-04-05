import { describe, expect, it } from "bun:test";

import type { TrackSelector } from "@vicissitude/spotify/selector";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

// --- test fixtures ---

function createTrack(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
	return {
		id: overrides.id ?? "track-1",
		name: overrides.name ?? "Test Song",
		artistName: overrides.artistName ?? "Test Artist",
		artistId: overrides.artistId ?? "artist-1",
		albumName: overrides.albumName ?? "Test Album",
		genres: overrides.genres ?? [],
		popularity: overrides.popularity ?? 50,
		releaseDate: overrides.releaseDate ?? "2024-01-01",
		albumArtUrl: overrides.albumArtUrl ?? "https://example.com/art.jpg",
	};
}

describe("TrackSelector", () => {
	it("楽曲リストから1曲を選曲できる", async () => {
		const { createTrackSelector } = await import("@vicissitude/spotify/selector");
		const selector: TrackSelector = createTrackSelector();

		const tracks = [
			createTrack({ id: "a", name: "Song A" }),
			createTrack({ id: "b", name: "Song B" }),
			createTrack({ id: "c", name: "Song C" }),
		];

		const selected = selector.select(tracks);

		expect(selected).not.toBeNull();
		expect(tracks.some((t) => t.id === selected?.id)).toBe(true);
	});

	it("人気度が高い曲ほど選ばれやすい（重み付け）", async () => {
		const { createTrackSelector } = await import("@vicissitude/spotify/selector");
		const selector: TrackSelector = createTrackSelector();

		const popular = createTrack({ id: "popular", popularity: 100 });
		const unpopular = createTrack({ id: "unpopular", popularity: 1 });
		const tracks = [popular, unpopular];

		// Run many selections and count
		const counts = { popular: 0, unpopular: 0 };
		const iterations = 1000;
		for (let i = 0; i < iterations; i++) {
			const selected = selector.select(tracks);
			if (selected?.id === "popular") counts.popular++;
			if (selected?.id === "unpopular") counts.unpopular++;
		}

		// Popular track should be selected significantly more often
		expect(counts.popular).toBeGreaterThan(counts.unpopular);
	});

	it("空リストの場合は null を返す", async () => {
		const { createTrackSelector } = await import("@vicissitude/spotify/selector");
		const selector: TrackSelector = createTrackSelector();

		const selected = selector.select([]);

		expect(selected).toBeNull();
	});

	it("複数ソース（Saved Tracks + Recently Played + Playlist）を統合して選曲できる", async () => {
		const { createTrackSelector } = await import("@vicissitude/spotify/selector");
		const selector: TrackSelector = createTrackSelector();

		const savedTracks = [createTrack({ id: "saved-1", name: "Saved Song" })];
		const recentlyPlayed = [createTrack({ id: "recent-1", name: "Recent Song" })];
		const playlistTracks = [createTrack({ id: "playlist-1", name: "Playlist Song" })];

		const allTracks = [...savedTracks, ...recentlyPlayed, ...playlistTracks];
		const selected = selector.select(allTracks);

		expect(selected).not.toBeNull();
		expect(allTracks.some((t) => t.id === selected?.id)).toBe(true);
	});

	it("1曲だけのリストではその曲が必ず選ばれる", async () => {
		const { createTrackSelector } = await import("@vicissitude/spotify/selector");
		const selector: TrackSelector = createTrackSelector();

		const tracks = [createTrack({ id: "only-one", name: "Only Song" })];

		const selected = selector.select(tracks);

		expect(selected).not.toBeNull();
		expect(selected?.id).toBe("only-one");
	});
});
