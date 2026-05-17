import {
	createSpotifyRuntimeDeps,
	type SpotifyRuntimeDeps,
	type SpotifyRuntimeDepsInput,
} from "./runtime-deps.ts";
import type { SpotifyTrack } from "./types.ts";

export type TrackSelectorDeps = Pick<SpotifyRuntimeDepsInput, "random">;

export class TrackSelector {
	private readonly deps: Pick<SpotifyRuntimeDeps, "random">;

	constructor(deps: TrackSelectorDeps = {}) {
		this.deps = createSpotifyRuntimeDeps(deps);
	}

	select(tracks: SpotifyTrack[]): SpotifyTrack | null {
		if (tracks.length === 0) return null;

		const weights = tracks.map((t) => Math.max(t.popularity, 1));
		const totalWeight = weights.reduce((sum, w) => sum + w, 0);
		let random = this.deps.random() * totalWeight;

		for (const [i, track] of tracks.entries()) {
			random -= weights[i] ?? 1;
			if (random <= 0) return track;
		}

		return tracks.at(-1) ?? null;
	}
}
