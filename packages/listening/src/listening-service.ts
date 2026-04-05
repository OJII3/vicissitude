import type { SpotifyTrack } from "@vicissitude/spotify/types";

import type {
	ListeningMemoryPort,
	ListeningRecord,
	LyricsPort,
	TrackLlmInput,
	TrackLlmPort,
} from "./types.ts";

export class ListeningService {
	constructor(
		private readonly lyrics: LyricsPort,
		private readonly llm: TrackLlmPort,
		private readonly memory: ListeningMemoryPort,
	) {}

	async listenTo(track: SpotifyTrack): Promise<ListeningRecord> {
		// 歌詞取得の失敗は致命的ではない — 楽曲によっては Genius に無い
		const lyrics = await this.tryFetchLyrics(track);

		const llmInput: TrackLlmInput = {
			title: track.name,
			artistName: track.artistName,
			albumName: track.albumName,
			genres: track.genres,
			releaseDate: track.releaseDate,
			lyrics,
		};

		const understanding = await this.llm.inferUnderstanding(llmInput);
		const impression = await this.llm.generateImpression({ ...llmInput, understanding });

		const record: ListeningRecord = {
			track,
			lyrics,
			understanding,
			impression,
			listenedAt: new Date(),
		};

		await this.memory.saveListening(record);
		return record;
	}

	private async tryFetchLyrics(track: SpotifyTrack): Promise<string | null> {
		try {
			return await this.lyrics.fetchLyrics(track);
		} catch {
			return null;
		}
	}
}
