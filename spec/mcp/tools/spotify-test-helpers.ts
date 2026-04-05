/* oxlint-disable no-non-null-assertion -- test helpers */
/* oxlint-disable max-classes-per-file -- モック内の小クラス定義 */
import { mock } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { registerSpotifyTools } from "@vicissitude/mcp/tools/spotify";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

import type { ToolHandler } from "./discord-test-helpers";

// ─── Mutable stubs ──────────────────────────────────────────────
// mock.module はファイルトップレベルで1回だけ呼ぶ必要がある。
// 各テストケースでは stubs オブジェクトのプロパティを差し替えて振る舞いを変える。

export const stubs = {
	getSavedTracks: (_limit: number, _offset: number): Promise<SpotifyTrack[]> => Promise.resolve([]),
	getRecentlyPlayed: (_limit: number): Promise<SpotifyTrack[]> => Promise.resolve([]),
	getPlaylistTracks: (_id: string): Promise<SpotifyTrack[]> => Promise.resolve([]),
	getArtist: (_id: string): Promise<{ genres: string[] }> => Promise.resolve({ genres: [] }),
	select: (_tracks: SpotifyTrack[]): SpotifyTrack | null => null,
};

void mock.module("@vicissitude/spotify/auth", () => ({
	SpotifyAuth: class {
		getAccessToken(): Promise<string> {
			return Promise.resolve("test-access-token");
		}
	},
}));

void mock.module("@vicissitude/spotify/spotify-client", () => ({
	SpotifyClient: class {
		getSavedTracks(limit: number, offset: number) {
			return stubs.getSavedTracks(limit, offset);
		}
		getRecentlyPlayed(limit: number) {
			return stubs.getRecentlyPlayed(limit);
		}
		getPlaylistTracks(id: string) {
			return stubs.getPlaylistTracks(id);
		}
		getArtist(id: string) {
			return stubs.getArtist(id);
		}
	},
}));

void mock.module("@vicissitude/spotify/selector", () => ({
	TrackSelector: class {
		select(tracks: SpotifyTrack[]) {
			return stubs.select(tracks);
		}
	},
}));

// ─── captureSpotifyTool ─────────────────────────────────────────

export type SpotifyConfig = Parameters<typeof registerSpotifyTools>[1];

const defaultConfig: SpotifyConfig = {
	clientId: "test-client-id",
	clientSecret: "test-client-secret",
	refreshToken: "test-refresh-token",
};

/**
 * registerSpotifyTools で登録されたツールを name → handler のマップとして取得する。
 * mock.module の後にインポートする必要があるため、動的インポートを使用。
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

	registerSpotifyTools(fakeServer, { ...defaultConfig, ...overrides });
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
	stubs.select = () => null;
}
