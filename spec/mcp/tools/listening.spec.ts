/* oxlint-disable no-non-null-assertion -- test assertions after null checks */
import { beforeEach, describe, expect, test } from "bun:test";

import type { SpotifyTrack } from "@vicissitude/spotify/types";

import type { ToolHandler, ToolResult } from "./discord-test-helpers";
import {
	captureListeningTools,
	listeningStubs,
	resetListeningStubs,
} from "./listening-test-helpers";

// ─── Helper ─────────────────────────────────────────────────────

async function getHandler(name: string): Promise<ToolHandler> {
	const { tools } = await captureListeningTools();
	return tools.get(name)!;
}

// ─── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
	resetListeningStubs();
});

describe("registerListeningTools", () => {
	test("fetch_lyrics と save_listening_fact の2つのツールが登録される", async () => {
		const { tools } = await captureListeningTools();

		expect(tools.has("fetch_lyrics")).toBe(true);
		expect(tools.has("save_listening_fact")).toBe(true);
		expect(tools.size).toBe(2);
	});
});

describe("fetch_lyrics", () => {
	test("成功時: 歌詞文字列が text として返る", async () => {
		listeningStubs.fetchLyrics = () => Promise.resolve("夜に駆ける〜\nサンプル歌詞");

		const handler = await getHandler("fetch_lyrics");
		const result = (await handler({ title: "夜に駆ける", artist: "YOASOBI" })) as ToolResult;

		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("夜に駆ける〜");
		expect(result.content[0]!.text).toContain("サンプル歌詞");
	});

	test("歌詞が見つからない (null) 場合: isError なし、歌詞なしを示すテキストが返る", async () => {
		listeningStubs.fetchLyrics = () => Promise.resolve(null);

		const handler = await getHandler("fetch_lyrics");
		const result = (await handler({ title: "存在しない曲", artist: "Unknown" })) as ToolResult;

		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text.length).toBeGreaterThan(0);
	});

	test("ネットワークエラー時: isError: true が返る（呼び出し元が例外で落ちない）", async () => {
		listeningStubs.fetchLyrics = () => Promise.reject(new Error("Genius API down"));

		const handler = await getHandler("fetch_lyrics");
		const result = (await handler({ title: "X", artist: "Y" })) as ToolResult;

		expect(result.isError).toBe(true);
	});

	test("title / artist 引数が下位層 fetchLyrics に渡される", async () => {
		const calls: Array<{ title: string; artist: string }> = [];
		listeningStubs.fetchLyrics = (title, artist) => {
			calls.push({ title, artist });
			return Promise.resolve("歌詞");
		};

		const handler = await getHandler("fetch_lyrics");
		await handler({ title: "群青", artist: "YOASOBI" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.title).toBe("群青");
		expect(calls[0]?.artist).toBe("YOASOBI");
	});
});

describe("save_listening_fact", () => {
	test("正常系: track と impression を渡すと Memory に保存され、成功テキストが返る", async () => {
		const saved: Array<{
			track: SpotifyTrack;
			impression: string;
			listenedAt: Date;
		}> = [];
		listeningStubs.saveListening = (record) => {
			saved.push(record);
			return Promise.resolve();
		};

		const handler = await getHandler("save_listening_fact");
		const result = (await handler({
			track: {
				id: "t-1",
				name: "夜に駆ける",
				artistName: "YOASOBI",
				artistId: "a-1",
				albumName: "THE BOOK",
				genres: ["j-pop"],
				popularity: 85,
				releaseDate: "2020-12-15",
				albumArtUrl: "https://example.com/art.jpg",
			},
			impression: "歌詞が切なくて好き",
		})) as ToolResult;

		expect(result.isError).toBeUndefined();
		expect(saved).toHaveLength(1);
		expect(saved[0]?.impression).toBe("歌詞が切なくて好き");
		expect(saved[0]!.track.name).toBe("夜に駆ける");
	});

	test("saveListening 呼び出し時に listenedAt が Date として付与される", async () => {
		const saved: Array<{ listenedAt: Date }> = [];
		listeningStubs.saveListening = (record) => {
			saved.push({ listenedAt: record.listenedAt });
			return Promise.resolve();
		};

		const handler = await getHandler("save_listening_fact");
		await handler({
			track: { id: "t-1", name: "曲", artistName: "A" },
			impression: "感想",
		});

		expect(saved[0]?.listenedAt).toBeInstanceOf(Date);
	});

	test("track オブジェクトがそのまま下位層 saveListening に渡される", async () => {
		const saved: Array<{ track: SpotifyTrack }> = [];
		listeningStubs.saveListening = (record) => {
			saved.push({ track: record.track });
			return Promise.resolve();
		};

		const handler = await getHandler("save_listening_fact");
		const track = {
			id: "t-xyz",
			name: "群青",
			artistName: "YOASOBI",
			artistId: "a-1",
			albumName: "Album",
			genres: ["j-pop"],
			popularity: 90,
			releaseDate: "2020-01-01",
			albumArtUrl: "https://example.com/x.jpg",
		};
		await handler({ track, impression: "爽やか" });

		expect(saved[0]?.track).toMatchObject({
			id: "t-xyz",
			name: "群青",
			artistName: "YOASOBI",
		});
	});

	test("saveListening が失敗した場合: isError: true が返る", async () => {
		listeningStubs.saveListening = () => Promise.reject(new Error("DB write failed"));

		const handler = await getHandler("save_listening_fact");
		const result = (await handler({
			track: { id: "t-1", name: "曲", artistName: "A" },
			impression: "感想",
		})) as ToolResult;

		expect(result.isError).toBe(true);
	});
});
