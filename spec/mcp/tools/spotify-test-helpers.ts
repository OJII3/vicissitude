/* oxlint-disable no-non-null-assertion -- test helpers */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { registerSpotifyTools, SpotifyToolDeps } from "@vicissitude/mcp/tools/spotify";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

import type { ToolHandler } from "./discord-test-helpers";

// ─── Mutable stubs ──────────────────────────────────────────────

export const stubs = {
	getSavedTracks: (_limit: number, _offset: number): Promise<SpotifyTrack[]> => Promise.resolve([]),
	getRecentlyPlayed: (_limit: number): Promise<SpotifyTrack[]> => Promise.resolve([]),
	getPlaylistTracks: (_id: string): Promise<SpotifyTrack[]> => Promise.resolve([]),
	getArtist: (_id: string): Promise<{ genres: string[] }> => Promise.resolve({ genres: [] }),
	searchTracks: (_query: string, _limit: number): Promise<SpotifyTrack[]> => Promise.resolve([]),
	getTrack: (_id: string): Promise<SpotifyTrack> => Promise.resolve(createFakeTrack()),
	select: (_tracks: SpotifyTrack[]): SpotifyTrack | null => null,
};

// ─── captureSpotifyTool ─────────────────────────────────────────

export type SpotifyConfig = Parameters<typeof registerSpotifyTools>[1];

const defaultConfig: SpotifyConfig = {
	clientId: "test-client-id",
	clientSecret: "test-client-secret",
	refreshToken: "test-refresh-token",
};

/**
 * registerSpotifyTools で登録されたツールを name → handler のマップとして取得する。
 * DI 経由で stubs を注入するため mock.module は不要。
 */
export async function captureSpotifyTool(
	overrides: Partial<SpotifyConfig> = {},
): Promise<{ tools: Map<string, ToolHandler> }> {
	const { registerSpotifyTools } = await import("@vicissitude/mcp/tools/spotify");

	const tools = new Map<string, ToolHandler>();
	const fakeServer = {
		registerTool(name: string, _schema: unknown, handler: ToolHandler) {
			tools.set(name, handler);
		},
	} as unknown as McpServer;

	const deps: SpotifyToolDeps = {
		getSavedTracks: (limit, offset) => stubs.getSavedTracks(limit, offset),
		getRecentlyPlayed: (limit) => stubs.getRecentlyPlayed(limit),
		getPlaylistTracks: (id) => stubs.getPlaylistTracks(id),
		getArtist: (id) => stubs.getArtist(id),
		searchTracks: (query, limit) => stubs.searchTracks(query, limit),
		getTrack: (id) => stubs.getTrack(id),
		select: (tracks) => stubs.select(tracks),
	};

	registerSpotifyTools(fakeServer, { ...defaultConfig, ...overrides }, undefined, deps);
	return { tools };
}

// ─── Factory ────────────────────────────────────────────────────

/** テスト用の SpotifyTrack を生成する */
export function createFakeTrack(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
	return {
		id: "track-1",
		name: "Test Song",
		artistName: "Test Artist",
		artistId: "artist-1",
		albumName: "Test Album",
		genres: ["pop"],
		popularity: 80,
		releaseDate: "2024-01-01",
		albumArtUrl: "https://example.com/art.jpg",
		...overrides,
	};
}

// ─── Reset ──────────────────────────────────────────────────────

/** stubs を初期状態にリセットする */
export function resetStubs(): void {
	stubs.getSavedTracks = () => Promise.resolve([]);
	stubs.getRecentlyPlayed = () => Promise.resolve([]);
	stubs.getPlaylistTracks = () => Promise.resolve([]);
	stubs.getArtist = () => Promise.resolve({ genres: [] });
	stubs.searchTracks = () => Promise.resolve([]);
	stubs.getTrack = () => Promise.resolve(createFakeTrack());
	stubs.select = () => null;
}
