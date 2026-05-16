import { describe, expect, test } from "bun:test";

import { registerConfiguredMediaTools } from "@vicissitude/mcp/core-server";

type RegisterArgs = Parameters<typeof registerConfiguredMediaTools>;
type Server = RegisterArgs[0];
type Registrars = RegisterArgs[2];
type SpotifyConfig = Parameters<Registrars["registerSpotify"]>[1];

function createCapture() {
	const spotifyConfigs: SpotifyConfig[] = [];
	const listeningTokens: string[] = [];
	const server = {} as Server;
	const registrars: Registrars = {
		registerSpotify: (_server, config) => {
			spotifyConfigs.push(config);
		},
		registerListening: (accessToken) => {
			listeningTokens.push(accessToken);
		},
	};

	return { listeningTokens, registrars, server, spotifyConfigs };
}

describe("registerConfiguredMediaTools", () => {
	test("Genius token があれば Spotify 設定なしでも listening tool を登録する", () => {
		const capture = createCapture();

		registerConfiguredMediaTools(
			capture.server,
			{ GENIUS_ACCESS_TOKEN: "genius-token" },
			capture.registrars,
		);

		expect(capture.listeningTokens).toEqual(["genius-token"]);
		expect(capture.spotifyConfigs).toEqual([]);
	});

	test("Spotify 設定が揃っていれば Spotify tool を登録する", () => {
		const capture = createCapture();

		registerConfiguredMediaTools(
			capture.server,
			{
				SPOTIFY_CLIENT_ID: "spotify-client-id",
				SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
				SPOTIFY_REFRESH_TOKEN: "spotify-refresh-token",
				SPOTIFY_RECOMMEND_PLAYLIST_ID: "playlist-id",
			},
			capture.registrars,
		);

		expect(capture.spotifyConfigs).toEqual([
			{
				clientId: "spotify-client-id",
				clientSecret: "spotify-client-secret",
				refreshToken: "spotify-refresh-token",
				recommendPlaylistId: "playlist-id",
			},
		]);
		expect(capture.listeningTokens).toEqual([]);
	});

	test("Spotify 設定が欠けている場合は Spotify tool を登録しない", () => {
		const capture = createCapture();

		registerConfiguredMediaTools(
			capture.server,
			{
				SPOTIFY_CLIENT_ID: "spotify-client-id",
				SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
				GENIUS_ACCESS_TOKEN: "genius-token",
			},
			capture.registrars,
		);

		expect(capture.spotifyConfigs).toEqual([]);
		expect(capture.listeningTokens).toEqual(["genius-token"]);
	});
});
