import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SpotifyAuth } from "@vicissitude/spotify/auth";
import { TrackSelector } from "@vicissitude/spotify/selector";
import { SpotifyClient } from "@vicissitude/spotify/spotify-client";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

export interface SpotifyToolDeps {
	getSavedTracks(limit: number, offset: number): Promise<SpotifyTrack[]>;
	getRecentlyPlayed(limit: number): Promise<SpotifyTrack[]>;
	getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]>;
	getArtist(artistId: string): Promise<{ genres: string[] }>;
	select(tracks: SpotifyTrack[]): SpotifyTrack | null;
}

export function registerSpotifyTools(
	server: McpServer,
	config: {
		clientId: string;
		clientSecret: string;
		refreshToken: string;
		recommendPlaylistId?: string;
	},
	deps?: SpotifyToolDeps,
): void {
	const d =
		deps ??
		(() => {
			const auth = new SpotifyAuth({
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				refreshToken: config.refreshToken,
			});
			const client = new SpotifyClient(auth);
			const selector = new TrackSelector();
			return {
				getSavedTracks: d.getSavedTracks.bind(client),
				getRecentlyPlayed: d.getRecentlyPlayed.bind(client),
				getPlaylistTracks: d.getPlaylistTracks.bind(client),
				getArtist: d.getArtist.bind(client),
				select: selector.select.bind(selector),
			};
		})();

	server.registerTool(
		"spotify_pick_track",
		{
			description:
				"Spotify ライブラリ（Saved Tracks, Recently Played, おすすめプレイリスト）から1曲ランダムに選んで情報を返す。人気度で重み付けされた選曲。",
		},
		async () => {
			const tracks: SpotifyTrack[] = [];

			const results = await Promise.allSettled([
				d.getSavedTracks(50, 0),
				d.getRecentlyPlayed(50),
				...(config.recommendPlaylistId ? [d.getPlaylistTracks(config.recommendPlaylistId)] : []),
			]);

			const errors: string[] = [];
			for (const result of results) {
				if (result.status === "fulfilled") {
					tracks.push(...result.value);
				} else {
					errors.push(String(result.reason));
				}
			}

			if (tracks.length === 0) {
				const detail = errors.length > 0 ? ` (${errors.join("; ")})` : "";
				return {
					content: [{ type: "text", text: `楽曲が見つかりませんでした。${detail}` }],
					isError: true,
				};
			}

			const picked = d.select(tracks);
			if (!picked) {
				return {
					content: [{ type: "text", text: "選曲に失敗しました。" }],
					isError: true,
				};
			}

			let genres = picked.genres;
			if (genres.length === 0 && picked.artistId) {
				try {
					const artist = await d.getArtist(picked.artistId);
					genres = artist.genres;
				} catch {
					// genres fetch failure is non-critical
				}
			}

			const info = {
				id: picked.id,
				name: picked.name,
				artistName: picked.artistName,
				albumName: picked.albumName,
				genres,
				popularity: picked.popularity,
				releaseDate: picked.releaseDate,
				albumArtUrl: picked.albumArtUrl,
				spotifyUrl: `https://open.spotify.com/track/${picked.id}`,
			};

			return {
				content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
			};
		},
	);
}
