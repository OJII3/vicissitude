import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SpotifyAuth } from "@vicissitude/spotify/auth";
import { TrackSelector } from "@vicissitude/spotify/selector";
import { SpotifyClient } from "@vicissitude/spotify/spotify-client";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

export interface SpotifyToolLogger {
	info(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

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
	logger?: SpotifyToolLogger,
): void {
	const d =
		deps ??
		(() => {
			const auth = new SpotifyAuth(
				{
					clientId: config.clientId,
					clientSecret: config.clientSecret,
					refreshToken: config.refreshToken,
				},
				logger,
			);
			const client = new SpotifyClient(auth, logger);
			const selector = new TrackSelector();
			return {
				getSavedTracks: client.getSavedTracks.bind(client),
				getRecentlyPlayed: client.getRecentlyPlayed.bind(client),
				getPlaylistTracks: client.getPlaylistTracks.bind(client),
				getArtist: client.getArtist.bind(client),
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
			logger?.info("[spotify:pick] spotify_pick_track 呼び出し開始");
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

			if (errors.length > 0) {
				logger?.error(`[spotify:pick] 一部ソース取得失敗: ${errors.join("; ")}`);
			}
			logger?.info(`[spotify:pick] 候補曲数: ${tracks.length}`);

			if (tracks.length === 0) {
				const detail = errors.length > 0 ? ` (${errors.join("; ")})` : "";
				logger?.error(`[spotify:pick] 楽曲が見つかりませんでした${detail}`);
				return {
					content: [{ type: "text", text: `楽曲が見つかりませんでした。${detail}` }],
					isError: true,
				};
			}

			const picked = d.select(tracks);
			if (!picked) {
				logger?.error("[spotify:pick] 選曲に失敗しました");
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

			logger?.info(
				`[spotify:pick] 選曲結果: "${picked.name}" - ${picked.artistName} (popularity=${picked.popularity})`,
			);

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
