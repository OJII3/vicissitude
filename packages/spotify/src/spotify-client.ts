import type { SpotifyAuth } from "./auth.ts";
import type { SpotifyTrack } from "./types.ts";

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

export class SpotifyClient {
	constructor(private readonly auth: Pick<SpotifyAuth, "getAccessToken">) {}

	private async apiGet(path: string): Promise<unknown> {
		const token = await this.auth.getAccessToken();
		const response = await fetch(`${API_BASE}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
		}

		return response.json();
	}

	async getSavedTracks(limit: number, offset: number): Promise<SpotifyTrack[]> {
		const data = (await this.apiGet(`/me/tracks?limit=${limit}&offset=${offset}`)) as {
			items: Array<{ track: SpotifyApiTrack }>;
		};
		return data.items.map((item) => normalizeTrack(item.track));
	}

	async getRecentlyPlayed(limit: number): Promise<SpotifyTrack[]> {
		const data = (await this.apiGet(`/me/player/recently-played?limit=${limit}`)) as {
			items: Array<{ track: SpotifyApiTrack }>;
		};
		return data.items.map((item) => normalizeTrack(item.track));
	}

	async getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
		const data = (await this.apiGet(`/playlists/${playlistId}/tracks`)) as {
			items: Array<{ track: SpotifyApiTrack }>;
		};
		return data.items.map((item) => normalizeTrack(item.track));
	}

	async getArtist(artistId: string): Promise<{ id: string; name: string; genres: string[] }> {
		const data = (await this.apiGet(`/artists/${artistId}`)) as {
			id: string;
			name: string;
			genres: string[];
		};
		return { id: data.id, name: data.name, genres: data.genres };
	}
}
