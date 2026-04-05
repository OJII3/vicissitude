import type { SpotifyAuth } from "./auth.ts";
import type { SpotifyTrack } from "./types.ts";

export type { SpotifyClient };

interface SpotifyClient {
	getSavedTracks(limit: number, offset: number): Promise<SpotifyTrack[]>;
	getRecentlyPlayed(limit: number): Promise<SpotifyTrack[]>;
	getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]>;
	getArtist(artistId: string): Promise<{ id: string; name: string; genres: string[] }>;
}

const API_BASE = "https://api.spotify.com/v1";

interface SpotifyApiTrack {
	id: string;
	name: string;
	artists: Array<{ id: string; name: string }>;
	album: {
		name: string;
		release_date: string;
		images: Array<{ url: string }>;
	};
	popularity: number;
}

function normalizeTrack(raw: SpotifyApiTrack): SpotifyTrack {
	return {
		id: raw.id,
		name: raw.name,
		artistName: raw.artists[0]?.name ?? "Unknown",
		artistId: raw.artists[0]?.id ?? "",
		albumName: raw.album.name,
		genres: [],
		popularity: raw.popularity,
		releaseDate: raw.album.release_date,
		albumArtUrl: raw.album.images[0]?.url ?? "",
	};
}

export function createSpotifyClient(auth: SpotifyAuth): SpotifyClient {
	async function apiGet(path: string): Promise<unknown> {
		const token = await auth.getAccessToken();
		const response = await fetch(`${API_BASE}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
		}

		return response.json();
	}

	return {
		async getSavedTracks(limit, offset) {
			const data = (await apiGet(`/me/tracks?limit=${limit}&offset=${offset}`)) as {
				items: Array<{ track: SpotifyApiTrack }>;
			};
			return data.items.map((item) => normalizeTrack(item.track));
		},

		async getRecentlyPlayed(limit) {
			const data = (await apiGet(`/me/player/recently-played?limit=${limit}`)) as {
				items: Array<{ track: SpotifyApiTrack }>;
			};
			return data.items.map((item) => normalizeTrack(item.track));
		},

		async getPlaylistTracks(playlistId) {
			const data = (await apiGet(`/playlists/${playlistId}/tracks`)) as {
				items: Array<{ track: SpotifyApiTrack }>;
			};
			return data.items.map((item) => normalizeTrack(item.track));
		},

		async getArtist(artistId) {
			const data = (await apiGet(`/artists/${artistId}`)) as {
				id: string;
				name: string;
				genres: string[];
			};
			return { id: data.id, name: data.name, genres: data.genres };
		},
	};
}
