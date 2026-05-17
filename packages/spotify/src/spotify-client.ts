import { z } from "zod";

import type { SpotifyAuthPort, SpotifyLogger } from "./auth.ts";
import {
	createSpotifyRuntimeDeps,
	type SpotifyRuntimeDeps,
	type SpotifyRuntimeDepsInput,
} from "./runtime-deps.ts";
import {
	spotifyHttpUrlSchema,
	spotifyNonEmptyStringSchema,
	spotifyReleaseDateSchema,
	type SpotifyTrack,
	spotifyTrackSchema,
} from "./types.ts";

const API_BASE = "https://api.spotify.com/v1";

const spotifyApiArtistRefSchema = z.object({
	id: spotifyNonEmptyStringSchema,
	name: spotifyNonEmptyStringSchema,
});

const spotifyApiTrackSchema = z.object({
	id: spotifyNonEmptyStringSchema,
	name: spotifyNonEmptyStringSchema,
	artists: z.array(spotifyApiArtistRefSchema).min(1),
	album: z.object({
		name: spotifyNonEmptyStringSchema,
		release_date: spotifyReleaseDateSchema,
		images: z.array(z.object({ url: spotifyHttpUrlSchema })).min(1),
	}),
	popularity: z.number().int().min(0).max(100),
});

const spotifyTracksPageSchema = z.object({
	items: z.array(z.object({ track: spotifyApiTrackSchema })),
});

const spotifyRecentlyPlayedSchema = z.object({
	items: z.array(z.object({ track: spotifyApiTrackSchema })),
});

const spotifyArtistSchema = z.object({
	id: spotifyNonEmptyStringSchema,
	name: spotifyNonEmptyStringSchema,
	genres: z.array(spotifyNonEmptyStringSchema),
});

const spotifySearchResponseSchema = z.object({
	tracks: z.object({ items: z.array(spotifyApiTrackSchema) }),
});

type SpotifyApiTrack = z.infer<typeof spotifyApiTrackSchema>;

export interface SpotifyGenreHydrationDeps {
	getArtist(artistId: string): Promise<{ genres: string[] }>;
	logger?: SpotifyLogger;
}

function formatZodPath(path: PropertyKey[]): string {
	if (path.length === 0) return "(root)";
	return path.map(String).join(".");
}

function formatZodError(error: z.ZodError): string {
	return error.issues.map((issue) => `${formatZodPath(issue.path)}: ${issue.message}`).join("; ");
}

function parseSpotifyApiResponse<T>(path: string, schema: z.ZodType<T>, data: unknown): T {
	const result = schema.safeParse(data);
	if (!result.success) {
		throw new Error(`Invalid Spotify API response (${path}): ${formatZodError(result.error)}`);
	}
	return result.data;
}

function normalizeTrack(raw: SpotifyApiTrack): SpotifyTrack {
	const artist = raw.artists[0];
	const image = raw.album.images[0];
	if (!artist || !image) {
		throw new Error("Invalid Spotify API response: track is missing artist or album image");
	}

	return spotifyTrackSchema.parse({
		id: raw.id,
		name: raw.name,
		artistName: artist.name,
		artistId: artist.id,
		albumName: raw.album.name,
		genres: [],
		popularity: raw.popularity,
		releaseDate: raw.album.release_date,
		albumArtUrl: image.url,
	});
}

export async function hydrateSpotifyTrackGenres(
	track: SpotifyTrack,
	deps: SpotifyGenreHydrationDeps,
): Promise<SpotifyTrack> {
	const parsedTrack = spotifyTrackSchema.parse(track);
	if (parsedTrack.genres.length > 0) return parsedTrack;

	try {
		const artist = await deps.getArtist(parsedTrack.artistId);
		return spotifyTrackSchema.parse({ ...parsedTrack, genres: artist.genres });
	} catch (error) {
		deps.logger?.error(`[spotify:api] hydrateGenres failed: ${String(error)}`);
		return parsedTrack;
	}
}

export class SpotifyClient {
	private readonly deps: SpotifyRuntimeDeps;

	constructor(
		private readonly auth: SpotifyAuthPort,
		private readonly logger?: SpotifyLogger,
		deps: SpotifyRuntimeDepsInput = {},
	) {
		this.deps = createSpotifyRuntimeDeps(deps);
	}

	private async apiGet(path: string): Promise<unknown> {
		const token = await this.auth.getAccessToken();
		const response = await this.deps.fetch(`${API_BASE}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: this.deps.timeoutSignal(10_000),
		});

		if (!response.ok) {
			const msg = `Spotify API error: ${response.status} ${response.statusText} (${path})`;
			this.logger?.error(`[spotify:api] ${msg}`);
			throw new Error(msg);
		}

		return response.json();
	}

	async getSavedTracks(limit: number, offset: number): Promise<SpotifyTrack[]> {
		const path = `/me/tracks?limit=${limit}&offset=${offset}`;
		const data = parseSpotifyApiResponse(path, spotifyTracksPageSchema, await this.apiGet(path));
		const tracks = data.items.map((item) => normalizeTrack(item.track));
		this.logger?.info(`[spotify:api] getSavedTracks: ${tracks.length}曲取得`);
		return tracks;
	}

	async getRecentlyPlayed(limit: number): Promise<SpotifyTrack[]> {
		const path = `/me/player/recently-played?limit=${limit}`;
		const data = parseSpotifyApiResponse(
			path,
			spotifyRecentlyPlayedSchema,
			await this.apiGet(path),
		);
		const tracks = data.items.map((item) => normalizeTrack(item.track));
		this.logger?.info(`[spotify:api] getRecentlyPlayed: ${tracks.length}曲取得`);
		return tracks;
	}

	async getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
		const path = `/playlists/${playlistId}/tracks`;
		const data = parseSpotifyApiResponse(path, spotifyTracksPageSchema, await this.apiGet(path));
		const tracks = data.items.map((item) => normalizeTrack(item.track));
		this.logger?.info(`[spotify:api] getPlaylistTracks(${playlistId}): ${tracks.length}曲取得`);
		return tracks;
	}

	async getArtist(artistId: string): Promise<{ id: string; name: string; genres: string[] }> {
		const path = `/artists/${artistId}`;
		const data = parseSpotifyApiResponse(path, spotifyArtistSchema, await this.apiGet(path));
		this.logger?.info(`[spotify:api] getArtist: ${data.name} (genres=${data.genres.join(",")})`);
		return { id: data.id, name: data.name, genres: data.genres };
	}

	async searchTracks(query: string, limit: number): Promise<SpotifyTrack[]> {
		const params = new URLSearchParams({ q: query, type: "track", limit: String(limit) });
		const path = `/search?${params.toString()}`;
		const data = parseSpotifyApiResponse(
			path,
			spotifySearchResponseSchema,
			await this.apiGet(path),
		);
		const tracks = data.tracks.items.map((item) => normalizeTrack(item));
		this.logger?.info(`[spotify:api] searchTracks("${query}"): ${tracks.length}曲取得`);
		return tracks;
	}

	async getTrack(trackId: string): Promise<SpotifyTrack> {
		const path = `/tracks/${trackId}`;
		const data = parseSpotifyApiResponse(path, spotifyApiTrackSchema, await this.apiGet(path));
		this.logger?.info(`[spotify:api] getTrack: ${data.name}`);
		return normalizeTrack(data);
	}

	hydrateGenres(track: SpotifyTrack): Promise<SpotifyTrack> {
		return hydrateSpotifyTrackGenres(track, {
			getArtist: this.getArtist.bind(this),
			logger: this.logger,
		});
	}

	async getTrackDetail(trackId: string): Promise<SpotifyTrack> {
		return this.hydrateGenres(await this.getTrack(trackId));
	}
}
