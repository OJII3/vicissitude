import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "@vicissitude/shared/types";
import { SpotifyAuth } from "@vicissitude/spotify/auth";
import { TrackSelector } from "@vicissitude/spotify/selector";
import { SpotifyClient } from "@vicissitude/spotify/spotify-client";
import type { SpotifyTrack } from "@vicissitude/spotify/types";
import { z } from "zod";

export interface SpotifyToolDeps {
	getSavedTracks(limit: number, offset: number): Promise<SpotifyTrack[]>;
	getRecentlyPlayed(limit: number): Promise<SpotifyTrack[]>;
	getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]>;
	getArtist(artistId: string): Promise<{ genres: string[] }>;
	searchTracks(query: string, limit: number): Promise<SpotifyTrack[]>;
	getTrack(trackId: string): Promise<SpotifyTrack>;
	select(tracks: SpotifyTrack[]): SpotifyTrack | null;
}

function formatTrackInfo(track: SpotifyTrack): Record<string, unknown> {
	return {
		id: track.id,
		name: track.name,
		artistName: track.artistName,
		albumName: track.albumName,
		genres: track.genres,
		popularity: track.popularity,
		releaseDate: track.releaseDate,
		albumArtUrl: track.albumArtUrl,
		spotifyUrl: `https://open.spotify.com/track/${track.id}`,
	};
}

/* oxlint-disable-next-line max-lines-per-function -- MCP tool registration is declarative; splitting would fragment tool definitions */
export function registerSpotifyTools(
	server: McpServer,
	config: {
		clientId: string;
		clientSecret: string;
		refreshToken: string;
		recommendPlaylistId?: string;
	},
	logger?: Logger,
	deps?: SpotifyToolDeps,
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
				searchTracks: client.searchTracks.bind(client),
				getTrack: client.getTrack.bind(client),
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

			const info = formatTrackInfo({ ...picked, genres });

			return {
				content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
			};
		},
	);

	server.registerTool(
		"spotify_search",
		{
			description: "Spotify で楽曲を検索する。曲名・アーティスト名などのキーワードで検索できる。",
			inputSchema: {
				query: z.string().describe("検索クエリ（曲名、アーティスト名など）"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.default(10)
					.describe("取得件数（1-50、デフォルト10）"),
			},
		},
		async ({ query, limit }) => {
			try {
				const tracks = await d.searchTracks(query, limit);
				if (tracks.length === 0) {
					return {
						content: [{ type: "text", text: `「${query}」に一致する楽曲が見つかりませんでした。` }],
					};
				}
				const results = tracks.map((t) => formatTrackInfo(t));
				return {
					content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `検索に失敗しました: ${String(err)}` }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"spotify_saved_tracks",
		{
			description: "Spotify の「お気に入りの曲」（Saved Tracks / Liked Songs）を取得する。",
			inputSchema: {
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.default(20)
					.describe("取得件数（1-50、デフォルト20）"),
				offset: z
					.number()
					.int()
					.min(0)
					.default(0)
					.describe("取得開始位置（ページネーション用、デフォルト0）"),
			},
		},
		async ({ limit, offset }) => {
			try {
				const tracks = await d.getSavedTracks(limit, offset);
				if (tracks.length === 0) {
					return {
						content: [{ type: "text", text: "お気に入りの曲が見つかりませんでした。" }],
					};
				}
				const results = tracks.map((t) => formatTrackInfo(t));
				return {
					content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `お気に入り取得に失敗しました: ${String(err)}` }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"spotify_track_detail",
		{
			description:
				"Spotify のトラックIDから楽曲の詳細情報を取得する。アーティストのジャンル情報も含む。",
			inputSchema: {
				trackId: z.string().describe("Spotify トラック ID"),
			},
		},
		async ({ trackId }) => {
			try {
				const track = await d.getTrack(trackId);
				let genres = track.genres;
				if (genres.length === 0 && track.artistId) {
					try {
						const artist = await d.getArtist(track.artistId);
						genres = artist.genres;
					} catch {
						// genres fetch failure is non-critical
					}
				}
				const info = formatTrackInfo({ ...track, genres });
				return {
					content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `トラック情報の取得に失敗しました: ${String(err)}` }],
					isError: true,
				};
			}
		},
	);
}
