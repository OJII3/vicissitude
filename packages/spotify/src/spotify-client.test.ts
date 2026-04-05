import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { SpotifyClient } from "./spotify-client.ts";

// --- helpers ---

function stubAuth(token = "test-token") {
	return { getAccessToken: () => Promise.resolve(token) };
}

function makeFakeApiTrack(overrides: Record<string, unknown> = {}) {
	return {
		id: (overrides.id as string) ?? "t1",
		name: (overrides.name as string) ?? "Song",
		artists: (overrides.artists as unknown[]) ?? [{ id: "a1", name: "Artist" }],
		album: (overrides.album as Record<string, unknown>) ?? {
			name: "Album",
			release_date: "2024-01-01",
			images: [{ url: "https://img.example.com/1.jpg" }],
		},
		popularity: (overrides.popularity as number) ?? 50,
	};
}

describe("normalizeTrack", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("Spotify API レスポンスを SpotifyTrack 形式に変換する", async () => {
		const apiTrack = makeFakeApiTrack({
			id: "x1",
			name: "My Song",
			artists: [{ id: "ar1", name: "My Artist" }],
			album: {
				name: "My Album",
				release_date: "2025-03-15",
				images: [{ url: "https://img.example.com/cover.jpg" }],
			},
			popularity: 88,
		});

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ items: [{ track: apiTrack }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as unknown as typeof fetch;

		const client = new SpotifyClient(stubAuth());
		const tracks = await client.getSavedTracks(1, 0);
		const t = tracks[0];

		expect(t?.id).toBe("x1");
		expect(t?.name).toBe("My Song");
		expect(t?.artistName).toBe("My Artist");
		expect(t?.artistId).toBe("ar1");
		expect(t?.albumName).toBe("My Album");
		expect(t?.releaseDate).toBe("2025-03-15");
		expect(t?.albumArtUrl).toBe("https://img.example.com/cover.jpg");
		expect(t?.popularity).toBe(88);
		expect(t?.genres).toEqual([]);
	});

	it("artists が空配列の場合 artistName='Unknown', artistId='' になる", async () => {
		const apiTrack = makeFakeApiTrack({ artists: [] });

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ items: [{ track: apiTrack }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as unknown as typeof fetch;

		const client = new SpotifyClient(stubAuth());
		const tracks = await client.getSavedTracks(1, 0);

		expect(tracks[0]?.artistName).toBe("Unknown");
		expect(tracks[0]?.artistId).toBe("");
	});

	it("album.images が空配列の場合 albumArtUrl='' になる", async () => {
		const apiTrack = makeFakeApiTrack({
			album: { name: "A", release_date: "2024-01-01", images: [] },
		});

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ items: [{ track: apiTrack }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as unknown as typeof fetch;

		const client = new SpotifyClient(stubAuth());
		const tracks = await client.getSavedTracks(1, 0);

		expect(tracks[0]?.albumArtUrl).toBe("");
	});
});

describe("API パス構築", () => {
	let originalFetch: typeof globalThis.fetch;
	let capturedUrls: string[];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		capturedUrls = [];
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function installCaptureFetch(body: unknown) {
		globalThis.fetch = mock((url: string | URL | Request) => {
			capturedUrls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;
	}

	it("getSavedTracks が /me/tracks?limit=N&offset=M に問い合わせる", async () => {
		installCaptureFetch({ items: [] });
		const client = new SpotifyClient(stubAuth());
		await client.getSavedTracks(20, 5);

		expect(capturedUrls[0]).toBe("https://api.spotify.com/v1/me/tracks?limit=20&offset=5");
	});

	it("getRecentlyPlayed が /me/player/recently-played?limit=N に問い合わせる", async () => {
		installCaptureFetch({ items: [] });
		const client = new SpotifyClient(stubAuth());
		await client.getRecentlyPlayed(10);

		expect(capturedUrls[0]).toBe("https://api.spotify.com/v1/me/player/recently-played?limit=10");
	});

	it("getPlaylistTracks が /playlists/{id}/tracks に問い合わせる", async () => {
		installCaptureFetch({ items: [] });
		const client = new SpotifyClient(stubAuth());
		await client.getPlaylistTracks("abc123");

		expect(capturedUrls[0]).toBe("https://api.spotify.com/v1/playlists/abc123/tracks");
	});

	it("getArtist が /artists/{id} に問い合わせる", async () => {
		installCaptureFetch({ id: "a1", name: "A", genres: [] });
		const client = new SpotifyClient(stubAuth());
		await client.getArtist("a1");

		expect(capturedUrls[0]).toBe("https://api.spotify.com/v1/artists/a1");
	});
});

describe("Authorization ヘッダー", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("Bearer トークンが Authorization ヘッダーに設定される", async () => {
		let capturedHeaders: HeadersInit | undefined;

		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = init?.headers;
			return Promise.resolve(
				new Response(JSON.stringify({ items: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new SpotifyClient(stubAuth("my-secret-token"));
		await client.getSavedTracks(1, 0);

		const headers = capturedHeaders as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer my-secret-token");
	});

	it("getAccessToken が毎回呼ばれて最新トークンが使われる", async () => {
		let callCount = 0;
		const auth = {
			getAccessToken: () => Promise.resolve(`token-${++callCount}`),
		};

		const capturedHeaders: Array<Record<string, string>> = [];
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders.push(init?.headers as Record<string, string>);
			return Promise.resolve(
				new Response(JSON.stringify({ items: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new SpotifyClient(auth);
		await client.getSavedTracks(1, 0);
		await client.getSavedTracks(1, 0);

		expect(capturedHeaders[0]?.Authorization).toBe("Bearer token-1");
		expect(capturedHeaders[1]?.Authorization).toBe("Bearer token-2");
	});
});
