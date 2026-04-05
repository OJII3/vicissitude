import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSpotifyAuth } from "@vicissitude/spotify/auth";
import { createTrackSelector } from "@vicissitude/spotify/selector";
import { createSpotifyClient } from "@vicissitude/spotify/spotify-client";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

export function registerSpotifyTools(
	server: McpServer,
	config: {
		clientId: string;
		clientSecret: string;
		refreshToken: string;
		recommendPlaylistId?: string;
	},
): void {
	const auth = createSpotifyAuth({
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		refreshToken: config.refreshToken,
	});
	const client = createSpotifyClient(auth);
	const selector = createTrackSelector();

	server.registerTool(
		"spotify_pick_track",
		{
			description:
				"Spotify のライブラリ（Saved Tracks, Recently Played, おすすめプレイリスト）からランダムに1曲選んで紹介する。人気度で重み付けされた選曲を行う。",
		},
		async () => {
			const tracks: SpotifyTrack[] = [];

			const results = await Promise.allSettled([
				client.getSavedTracks(50, 0),
				client.getRecentlyPlayed(50),
				...(config.recommendPlaylistId
					? [client.getPlaylistTracks(config.recommendPlaylistId)]
					: []),
			]);

			for (const result of results) {
				if (result.status === "fulfilled") {
					tracks.push(...result.value);
				}
			}

			if (tracks.length === 0) {
				return {
					content: [{ type: "text", text: "楽曲が見つかりませんでした。" }],
				};
			}

			const picked = selector.select(tracks);
			if (!picked) {
				return {
					content: [{ type: "text", text: "選曲に失敗しました。" }],
				};
			}

			let genres = picked.genres;
			if (genres.length === 0 && picked.artistId) {
				try {
					const artist = await client.getArtist(picked.artistId);
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
