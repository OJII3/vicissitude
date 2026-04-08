import type { SpotifyAuthPort, SpotifyLogger } from "./auth.ts";
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
	constructor(
		private readonly auth: SpotifyAuthPort,
		private readonly logger?: SpotifyLogger,
	) {}

	private async apiGet(path: string): Promise<unknown> {
		const token = await this.auth.getAccessToken();
		const response = await fetch(`${API_BASE}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			const msg = `Spotify API error: ${response.status} ${response.statusText} (${path})`;
			this.logger?.error(`[spotify:api] ${msg}`);
			throw new Error(msg);
		}

		return response.json();
	}

	async getSavedTracks(limit: number, offset: number): Promise<SpotifyTrack[]> {
		const data = (await this.apiGet(`/me/tracks?limit=${limit}&offset=${offset}`)) as {
			items: Array<{ track: SpotifyApiTrack }>;
		};
		const tracks = data.items.map((item) => normalizeTrack(item.track));
		this.logger?.info(`[spotify:api] getSavedTracks: ${tracks.length}曲取得`);
		return tracks;
	}

	async getRecentlyPlayed(limit: number): Promise<SpotifyTrack[]> {
		const data = (await this.apiGet(`/me/player/recently-played?limit=${limit}`)) as {
			items: Array<{ track: SpotifyApiTrack }>;
		};
		const tracks = data.items.map((item) => normalizeTrack(item.track));
		this.logger?.info(`[spotify:api] getRecentlyPlayed: ${tracks.length}曲取得`);
		return tracks;
	}

	async getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
		const data = (await this.apiGet(`/playlists/${playlistId}/tracks`)) as {
			items: Array<{ track: SpotifyApiTrack }>;
		};
		const tracks = data.items.map((item) => normalizeTrack(item.track));
		this.logger?.info(`[spotify:api] getPlaylistTracks(${playlistId}): ${tracks.length}曲取得`);
		return tracks;
	}

	async getArtist(artistId: string): Promise<{ id: string; name: string; genres: string[] }> {
		const data = (await this.apiGet(`/artists/${artistId}`)) as {
			id: string;
			name: string;
			genres: string[];
		};
		this.logger?.info(`[spotify:api] getArtist: ${data.name} (genres=${data.genres.join(",")})`);
		return { id: data.id, name: data.name, genres: data.genres };
	}
}
