import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

export type VocalGender = "male" | "female" | "mixed" | "unknown";

/** LLM による楽曲理解の結果 */
export interface TrackUnderstanding {
	vocalGender: VocalGender;
	/** アニメ・映画・CM 等のタイアップ情報。無ければ null */
	tieIn: string | null;
	moodThemes: string[];
	summary: string;
}

/** ふあが一曲聴き終えた時に生成される聴取記録 */
export interface ListeningRecord {
	track: SpotifyTrack;
	lyrics: string | null;
	understanding: TrackUnderstanding;
	impression: string;
	listenedAt: Date;
}

/** LLM に渡される楽曲コンテキスト */
export interface TrackLlmInput {
	title: string;
	artistName: string;
	albumName: string;
	genres: string[];
	releaseDate: string;
	lyrics: string | null;
}

/** LLM に感想生成を依頼する際の入力 */
export interface ImpressionInput extends TrackLlmInput {
	understanding: TrackUnderstanding;
}

/** 歌詞取得 Port（Genius 等の実装） */
export interface LyricsPort {
	fetchLyrics(track: SpotifyTrack): Promise<string | null>;
}

/** 楽曲理解・感想生成・embedding を行う LLM Port */
export interface TrackLlmPort {
	inferUnderstanding(input: TrackLlmInput): Promise<TrackUnderstanding>;
	generateImpression(input: ImpressionInput): Promise<string>;
	embed(text: string): Promise<number[]>;
}

/** 聴取記録を Memory に保存する Port */
export interface ListeningMemoryPort {
	saveListening(record: ListeningRecord): Promise<SemanticFact>;
}
