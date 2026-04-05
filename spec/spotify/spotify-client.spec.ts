import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { SpotifyClient } from "@vicissitude/spotify/spotify-client";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

// --- test fixtures ---

function createFakeSpotifyApiTrack(
	overrides: Partial<{
		id: string;
		name: string;
		artistName: string;
		artistId: string;
		albumName: string;
		popularity: number;
		releaseDate: string;
		albumArtUrl: string;
	}> = {},
) {
	return {
		id: overrides.id ?? "track-1",
		name: overrides.name ?? "Test Song",
		artists: [
			{ id: overrides.artistId ?? "artist-1", name: overrides.artistName ?? "Test Artist" },
		],
		album: {
			name: overrides.albumName ?? "Test Album",
			release_date: overrides.releaseDate ?? "2024-01-01",
			images: [
				{ url: overrides.albumArtUrl ?? "https://example.com/art.jpg", width: 300, height: 300 },
			],
		},
		popularity: overrides.popularity ?? 75,
	};
}

function savedTracksResponse(tracks = [createFakeSpotifyApiTrack()]) {
	return {
		status: 200,
		body: {
			items: tracks.map((t) => ({ track: t })),
			total: tracks.length,
			next: null,
		},
	};
}

function recentlyPlayedResponse(tracks = [createFakeSpotifyApiTrack()]) {
	return {
		status: 200,
		body: {
			items: tracks.map((t) => ({ track: t, played_at: "2024-01-01T00:00:00Z" })),
		},
	};
}

function playlistTracksResponse(tracks = [createFakeSpotifyApiTrack()]) {
	return {
		status: 200,
		body: {
			items: tracks.map((t) => ({ track: t })),
			total: tracks.length,
			next: null,
		},
	};
}

function artistResponse(genres = ["j-pop", "anime"]) {
	return {
		status: 200,
		body: {
			id: "artist-1",
			name: "Test Artist",
			genres,
		},
	};
}

function createMockFetch(responses: Array<{ status: number; body: unknown }>) {
	let callIndex = 0;
	return mock((_url: string | URL | Request, _init?: RequestInit) => {
		const res = responses[callIndex++];
		if (!res) throw new Error("unexpected fetch call");
		return Promise.resolve(
			new Response(JSON.stringify(res.body), {
				status: res.status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
}

// --- stub auth ---

function createStubAuth() {
	return { getAccessToken: () => Promise.resolve("test-access-token") };
}

describe("SpotifyClient", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("getSavedTracks(limit, offset) で Saved Tracks を取得できる", async () => {
		const tracks = [
			createFakeSpotifyApiTrack({ id: "t1", name: "Song A" }),
			createFakeSpotifyApiTrack({ id: "t2", name: "Song B" }),
		];
		globalThis.fetch = createMockFetch([savedTracksResponse(tracks)]) as unknown as typeof fetch;

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth());

		const result = await client.getSavedTracks(2, 0);

		expect(result).toHaveLength(2);
		expect(result[0]?.id).toBe("t1");
		expect(result[1]?.id).toBe("t2");
	});

	it("getRecentlyPlayed(limit) で最近再生した楽曲を取得できる", async () => {
		const tracks = [createFakeSpotifyApiTrack({ id: "recent-1", name: "Recent Song" })];
		globalThis.fetch = createMockFetch([recentlyPlayedResponse(tracks)]) as unknown as typeof fetch;

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth());

		const result = await client.getRecentlyPlayed(1);

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("recent-1");
		expect(result[0]?.name).toBe("Recent Song");
	});

	it("getPlaylistTracks(playlistId) でプレイリストの楽曲を取得できる", async () => {
		const tracks = [createFakeSpotifyApiTrack({ id: "pl-1", name: "Playlist Song" })];
		globalThis.fetch = createMockFetch([playlistTracksResponse(tracks)]) as unknown as typeof fetch;

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth());

		const result = await client.getPlaylistTracks("playlist-abc");

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("pl-1");
	});

	it("getArtist(artistId) でアーティスト情報（ジャンル含む）を取得できる", async () => {
		globalThis.fetch = createMockFetch([
			artistResponse(["rock", "j-pop"]),
		]) as unknown as typeof fetch;

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth());

		const artist = await client.getArtist("artist-1");

		expect(artist.id).toBe("artist-1");
		expect(artist.name).toBe("Test Artist");
		expect(artist.genres).toContain("rock");
		expect(artist.genres).toContain("j-pop");
	});

	it("返却値が SpotifyTrack 型に正規化されている", async () => {
		globalThis.fetch = createMockFetch([
			savedTracksResponse([
				createFakeSpotifyApiTrack({
					id: "norm-1",
					name: "Normalized Song",
					artistName: "Norm Artist",
					artistId: "norm-artist-1",
					albumName: "Norm Album",
					popularity: 80,
					releaseDate: "2024-06-15",
					albumArtUrl: "https://example.com/norm.jpg",
				}),
			]),
		]) as unknown as typeof fetch;

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth());

		const tracks = await client.getSavedTracks(1, 0);
		const track = tracks[0] as SpotifyTrack;

		expect(track.id).toBe("norm-1");
		expect(track.name).toBe("Normalized Song");
		expect(track.artistName).toBe("Norm Artist");
		expect(track.artistId).toBe("norm-artist-1");
		expect(track.albumName).toBe("Norm Album");
		expect(track.popularity).toBe(80);
		expect(track.releaseDate).toBe("2024-06-15");
		expect(track.albumArtUrl).toBe("https://example.com/norm.jpg");
		expect(Array.isArray(track.genres)).toBe(true);
	});

	it("HTTP エラー時に適切なエラーをスローする", async () => {
		globalThis.fetch = createMockFetch([
			{ status: 403, body: { error: { status: 403, message: "Forbidden" } } },
		]) as unknown as typeof fetch;

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth());

		expect(client.getSavedTracks(10, 0)).rejects.toThrow();
	});
});
