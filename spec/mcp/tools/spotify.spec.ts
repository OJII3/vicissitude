/* oxlint-disable no-non-null-assertion -- test assertions after null checks */
import { beforeEach, describe, expect, test } from "bun:test";

import type { ToolResult } from "./discord-test-helpers";
import { captureSpotifyTool, createFakeTrack, resetStubs, stubs } from "./spotify-test-helpers";

// ─── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
	resetStubs();
});

describe("registerSpotifyTools", () => {
	test("spotify_pick_track ツールが1つ登録される", async () => {
		const { tools } = await captureSpotifyTool();

		expect(tools.has("spotify_pick_track")).toBe(true);
		expect(tools.size).toBe(1);
	});
});

describe("spotify_pick_track", () => {
	test("正常系: tracks が集約され1曲選ばれて info が JSON で返る", async () => {
		const track = createFakeTrack();
		stubs.getSavedTracks = () => Promise.resolve([track]);
		stubs.getRecentlyPlayed = () => Promise.resolve([]);
		stubs.select = () => track;

		const { tools } = await captureSpotifyTool();
		const handler = tools.get("spotify_pick_track")!;
		const result = (await handler({})) as ToolResult;

		expect(result.isError).toBeUndefined();
		const info = JSON.parse(result.content[0]!.text);
		expect(info.id).toBe("track-1");
		expect(info.name).toBe("Test Song");
		expect(info.artistName).toBe("Test Artist");
		expect(info.albumName).toBe("Test Album");
		expect(info.genres).toEqual(["pop"]);
		expect(info.popularity).toBe(80);
		expect(info.releaseDate).toBe("2024-01-01");
		expect(info.albumArtUrl).toBe("https://example.com/art.jpg");
		expect(info.spotifyUrl).toBe("https://open.spotify.com/track/track-1");
	});

	test("空結果時: isError: true とエラーメッセージが返る", async () => {
		stubs.getSavedTracks = () => Promise.resolve([]);
		stubs.getRecentlyPlayed = () => Promise.resolve([]);

		const { tools } = await captureSpotifyTool();
		const handler = tools.get("spotify_pick_track")!;
		const result = (await handler({})) as ToolResult;

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("楽曲が見つかりませんでした。");
	});

	test("Promise.allSettled の一部失敗時: 成功したソースの結果で選曲できる", async () => {
		const track = createFakeTrack();
		stubs.getSavedTracks = () => Promise.reject(new Error("API error"));
		stubs.getRecentlyPlayed = () => Promise.resolve([track]);
		stubs.select = () => track;

		const { tools } = await captureSpotifyTool();
		const handler = tools.get("spotify_pick_track")!;
		const result = (await handler({})) as ToolResult;

		expect(result.isError).toBeUndefined();
		const info = JSON.parse(result.content[0]!.text);
		expect(info.id).toBe("track-1");
	});

	test("selector が null を返した場合: isError: true と選曲失敗メッセージ", async () => {
		const track = createFakeTrack();
		stubs.getSavedTracks = () => Promise.resolve([track]);
		stubs.getRecentlyPlayed = () => Promise.resolve([]);
		stubs.select = () => null;

		const { tools } = await captureSpotifyTool();
		const handler = tools.get("spotify_pick_track")!;
		const result = (await handler({})) as ToolResult;

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toBe("選曲に失敗しました。");
	});

	test("genres 空 + getArtist 成功時: アーティストのジャンルが info に含まれる", async () => {
		const track = createFakeTrack({ genres: [], artistId: "artist-1" });
		stubs.getSavedTracks = () => Promise.resolve([track]);
		stubs.getRecentlyPlayed = () => Promise.resolve([]);
		stubs.select = () => track;
		stubs.getArtist = () => Promise.resolve({ genres: ["j-pop", "rock"] });

		const { tools } = await captureSpotifyTool();
		const handler = tools.get("spotify_pick_track")!;
		const result = (await handler({})) as ToolResult;

		expect(result.isError).toBeUndefined();
		const info = JSON.parse(result.content[0]!.text);
		expect(info.genres).toEqual(["j-pop", "rock"]);
	});

	test("genres 空 + getArtist 失敗時: genres が空のまま info が返る（エラーにならない）", async () => {
		const track = createFakeTrack({ genres: [], artistId: "artist-1" });
		stubs.getSavedTracks = () => Promise.resolve([track]);
		stubs.getRecentlyPlayed = () => Promise.resolve([]);
		stubs.select = () => track;
		stubs.getArtist = () => Promise.reject(new Error("Artist API failure"));

		const { tools } = await captureSpotifyTool();
		const handler = tools.get("spotify_pick_track")!;
		const result = (await handler({})) as ToolResult;

		expect(result.isError).toBeUndefined();
		const info = JSON.parse(result.content[0]!.text);
		expect(info.genres).toEqual([]);
	});
});
