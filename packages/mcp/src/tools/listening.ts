import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SpotifyTrack } from "@vicissitude/spotify/types";
import { z } from "zod";

const spotifyTrackSchema = z.object({
	id: z.string(),
	name: z.string(),
	artistName: z.string(),
	artistId: z.string(),
	albumName: z.string(),
	genres: z.array(z.string()),
	popularity: z.number(),
	releaseDate: z.string(),
	albumArtUrl: z.string(),
});

export interface ListeningToolDeps {
	fetchLyrics(title: string, artist: string): Promise<string | null>;
	saveListening(record: {
		track: SpotifyTrack;
		impression: string;
		listenedAt: Date;
	}): Promise<void>;
}

export function registerListeningTools(server: McpServer, deps: ListeningToolDeps): void {
	server.registerTool(
		"fetch_lyrics",
		{
			description:
				"Genius API から指定された楽曲の歌詞を取得する。取得できなかった場合は歌詞なしを示すテキストを返す。",
			inputSchema: {
				title: z.string().describe("楽曲タイトル"),
				artist: z.string().describe("アーティスト名"),
			},
		},
		async ({ title, artist }) => {
			try {
				const lyrics = await deps.fetchLyrics(title, artist);
				if (lyrics === null) {
					return {
						content: [{ type: "text", text: `歌詞は見つかりませんでした: ${title} / ${artist}` }],
					};
				}
				return { content: [{ type: "text", text: lyrics }] };
			} catch (err) {
				return {
					content: [{ type: "text", text: `歌詞取得に失敗しました: ${String(err)}` }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"save_listening_fact",
		{
			description:
				"ふあが楽曲を聴いた感想を Memory (internal namespace, category=experience) に保存する。listenedAt は現在時刻が自動で付与される。",
			inputSchema: {
				track: spotifyTrackSchema.describe("Spotify Track オブジェクト"),
				impression: z.string().describe("ふあの感想"),
			},
		},
		async ({ track, impression }) => {
			try {
				await deps.saveListening({
					track,
					impression,
					listenedAt: new Date(),
				});
				return { content: [{ type: "text", text: "聴取記録を保存しました。" }] };
			} catch (err) {
				return {
					content: [{ type: "text", text: `保存に失敗しました: ${String(err)}` }],
					isError: true,
				};
			}
		},
	);
}
