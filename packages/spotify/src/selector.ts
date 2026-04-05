import type { SpotifyTrack } from "./types.ts";

export class TrackSelector {
	select(tracks: SpotifyTrack[]): SpotifyTrack | null {
		if (tracks.length === 0) return null;

		const weights = tracks.map((t) => Math.max(t.popularity, 1));
		const totalWeight = weights.reduce((sum, w) => sum + w, 0);
		let random = Math.random() * totalWeight;

		for (const [i, track] of tracks.entries()) {
			random -= weights[i] ?? 1;
			if (random <= 0) return track;
		}

		return tracks.at(-1) ?? null;
	}
}
