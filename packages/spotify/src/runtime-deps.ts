export interface SpotifyRuntimeDeps {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	timeoutSignal(milliseconds: number): AbortSignal;
	now(): number;
	random(): number;
}

export type SpotifyRuntimeDepsInput = Partial<SpotifyRuntimeDeps>;

export function createSpotifyRuntimeDeps(
	overrides: SpotifyRuntimeDepsInput = {},
): SpotifyRuntimeDeps {
	return {
		fetch: (input, init) => globalThis.fetch(input, init),
		timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
		now: () => Date.now(),
		random: () => Math.random(),
		...overrides,
	};
}
