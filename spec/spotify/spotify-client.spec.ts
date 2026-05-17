import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { SpotifyClient } from "@vicissitude/spotify/spotify-client";
import { spotifyTrackSchema, type SpotifyTrack } from "@vicissitude/spotify/types";

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

function createTestSignal(): AbortSignal {
	return new AbortController().signal;
}

async function expectInvalidSpotifyApiResponse(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
		throw new Error("expected Invalid Spotify API response");
	} catch (error) {
		expect(String(error)).toContain("Invalid Spotify API response");
	}
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

	it("SpotifyTrack は空文字、popularity 範囲、URL/date 形式を境界で検証する", () => {
		const validTrack: SpotifyTrack = {
			id: "track-1",
			name: "Test Song",
			artistName: "Test Artist",
			artistId: "artist-1",
			albumName: "Test Album",
			genres: ["j-pop"],
			popularity: 80,
			releaseDate: "2024-06-15",
			albumArtUrl: "https://example.com/art.jpg",
		};

		expect(spotifyTrackSchema.safeParse(validTrack).success).toBe(true);
		expect(spotifyTrackSchema.safeParse({ ...validTrack, id: "" }).success).toBe(false);
		expect(spotifyTrackSchema.safeParse({ ...validTrack, name: "   " }).success).toBe(false);
		expect(spotifyTrackSchema.safeParse({ ...validTrack, genres: [""] }).success).toBe(false);
		expect(spotifyTrackSchema.safeParse({ ...validTrack, popularity: -1 }).success).toBe(false);
		expect(spotifyTrackSchema.safeParse({ ...validTrack, popularity: 101 }).success).toBe(false);
		expect(spotifyTrackSchema.safeParse({ ...validTrack, popularity: 50.5 }).success).toBe(false);
		expect(spotifyTrackSchema.safeParse({ ...validTrack, releaseDate: "2024-13-01" }).success).toBe(
			false,
		);
		expect(spotifyTrackSchema.safeParse({ ...validTrack, albumArtUrl: "not-a-url" }).success).toBe(
			false,
		);
	});

	it("Spotify API 応答の不正な track は正規化前に拒否する", async () => {
		const invalidTracks = [
			createFakeSpotifyApiTrack({ id: "" }),
			createFakeSpotifyApiTrack({ name: "   " }),
			createFakeSpotifyApiTrack({ popularity: 101 }),
			createFakeSpotifyApiTrack({ releaseDate: "2024-13-01" }),
			createFakeSpotifyApiTrack({ albumArtUrl: "not-a-url" }),
		];

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");

		await Promise.all(
			invalidTracks.map((track) => {
				const client: SpotifyClient = new SpotifyClient(createStubAuth(), undefined, {
					fetch: createMockFetch([{ status: 200, body: { items: [{ track }] } }]),
					timeoutSignal: createTestSignal,
				});

				return expectInvalidSpotifyApiResponse(client.getSavedTracks(1, 0));
			}),
		);
	});

	it("fetch / timeoutSignal は注入された依存を使用する", async () => {
		const signal = createTestSignal();
		let capturedSignal: AbortSignal | null | undefined;
		const fetchFn = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedSignal = init?.signal;
			return Promise.resolve(
				new Response(JSON.stringify(savedTracksResponse([]).body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});
		const timeoutSignal = mock((ms: number) => {
			expect(ms).toBe(10_000);
			return signal;
		});

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth(), undefined, {
			fetch: fetchFn,
			timeoutSignal,
		});

		expect(await client.getSavedTracks(1, 0)).toEqual([]);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(timeoutSignal).toHaveBeenCalledTimes(1);
		expect(capturedSignal).toBe(signal);
	});

	it("hydrateGenres(track) は genres が空の track に artist genres を補完する", async () => {
		const track: SpotifyTrack = {
			id: "track-1",
			name: "Test Song",
			artistName: "Test Artist",
			artistId: "artist-1",
			albumName: "Test Album",
			genres: [],
			popularity: 80,
			releaseDate: "2024-06-15",
			albumArtUrl: "https://example.com/art.jpg",
		};
		globalThis.fetch = createMockFetch([
			artistResponse(["j-pop", "rock"]),
		]) as unknown as typeof fetch;

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth());

		const hydrated = await client.hydrateGenres(track);

		expect(hydrated).toEqual({ ...track, genres: ["j-pop", "rock"] });
	});

	it("hydrateGenres(track) は genres が既にある場合 artist API を呼ばない", async () => {
		const track: SpotifyTrack = {
			id: "track-1",
			name: "Test Song",
			artistName: "Test Artist",
			artistId: "artist-1",
			albumName: "Test Album",
			genres: ["city pop"],
			popularity: 80,
			releaseDate: "2024-06-15",
			albumArtUrl: "https://example.com/art.jpg",
		};
		const fetchFn = createMockFetch([artistResponse(["j-pop", "rock"])]);
		globalThis.fetch = fetchFn as unknown as typeof fetch;

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth());

		const hydrated = await client.hydrateGenres(track);

		expect(hydrated).toEqual(track);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("getTrackDetail(trackId) は track 取得後にジャンルを補完する", async () => {
		const urls: string[] = [];
		const fetchFn = mock((url: string | URL | Request, _init?: RequestInit) => {
			const textUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			urls.push(textUrl);
			const body =
				urls.length === 1
					? createFakeSpotifyApiTrack({ id: "track-1", artistId: "artist-1" })
					: artistResponse(["j-pop", "rock"]).body;
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});

		const { SpotifyClient } = await import("@vicissitude/spotify/spotify-client");
		const client: SpotifyClient = new SpotifyClient(createStubAuth(), undefined, {
			fetch: fetchFn,
			timeoutSignal: createTestSignal,
		});

		const track = await client.getTrackDetail("track-1");

		expect(track.genres).toEqual(["j-pop", "rock"]);
		expect(urls).toEqual([
			"https://api.spotify.com/v1/tracks/track-1",
			"https://api.spotify.com/v1/artists/artist-1",
		]);
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
