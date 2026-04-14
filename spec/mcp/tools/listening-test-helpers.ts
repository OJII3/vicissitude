/* oxlint-disable no-non-null-assertion -- test helpers */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { registerListeningTools } from "@vicissitude/mcp/tools/listening";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

import type { ToolHandler } from "./discord-test-helpers";

// ─── Mutable stubs ──────────────────────────────────────────────

export const listeningStubs = {
	fetchLyrics: (_title: string, _artist: string): Promise<string | null> => Promise.resolve(null),
	saveListening: (_record: {
		track: SpotifyTrack;
		impression: string;
		listenedAt: Date;
	}): Promise<void> => Promise.resolve(),
};

// ─── captureListeningTools ──────────────────────────────────────

export type ListeningToolDeps = Parameters<typeof registerListeningTools>[1];

export async function captureListeningTools(): Promise<{
	tools: Map<string, ToolHandler>;
}> {
	const { registerListeningTools } = await import("@vicissitude/mcp/tools/listening");

	const tools = new Map<string, ToolHandler>();
	const fakeServer = {
		registerTool(name: string, _schema: unknown, handler: ToolHandler) {
			tools.set(name, handler);
		},
	} as unknown as McpServer;

	const deps: ListeningToolDeps = {
		fetchLyrics: (title, artist) => listeningStubs.fetchLyrics(title, artist),
		saveListening: (record) => listeningStubs.saveListening(record),
	};

	registerListeningTools(fakeServer, deps);
	return { tools };
}

// ─── Reset ──────────────────────────────────────────────────────

export function resetListeningStubs(): void {
	listeningStubs.fetchLyrics = () => Promise.resolve(null);
	listeningStubs.saveListening = () => Promise.resolve();
}
