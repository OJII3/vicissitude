import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

/** ふあが一曲聴き終えた時に生成される聴取記録 */
export interface ListeningRecord {
	track: SpotifyTrack;
	impression: string;
	listenedAt: Date;
}

/** 聴取記録を Memory に保存する Port */
export interface ListeningMemoryPort {
	saveListening(record: ListeningRecord): Promise<SemanticFact>;
}
