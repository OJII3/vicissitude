/* oxlint-disable no-non-null-assertion -- test assertions */
import { beforeEach, describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

import { registerListeningTools } from "./listening.ts";
import type { ListeningToolDeps } from "./listening.ts";

// ─── Helpers ────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}>;

interface ToolRegistration {
	name: string;
	schema: {
		description: string;
		inputSchema: Record<string, z.ZodType>;
	};
	handler: ToolHandler;
}

function captureTools(deps: ListeningToolDeps): Map<string, ToolRegistration> {
	const tools = new Map<string, ToolRegistration>();
	const fakeServer = {
		registerTool(name: string, schema: ToolRegistration["schema"], handler: ToolHandler) {
			tools.set(name, { name, schema, handler });
		},
	} as unknown as McpServer;
	registerListeningTools(fakeServer, deps);
	return tools;
}

function stubDeps(overrides: Partial<ListeningToolDeps> = {}): ListeningToolDeps {
	return {
		fetchLyrics: overrides.fetchLyrics ?? (() => Promise.resolve(null)),
		saveListening: overrides.saveListening ?? (() => Promise.resolve()),
	};
}

// ─── Tool registration ──────────────────────────────────────────

describe("registerListeningTools — 登録", () => {
	test("fetch_lyrics と save_listening_fact の 2 つが登録される", () => {
		const tools = captureTools(stubDeps());
		expect(tools.size).toBe(2);
		expect(tools.has("fetch_lyrics")).toBe(true);
		expect(tools.has("save_listening_fact")).toBe(true);
	});

	test("各ツールに description が設定されている", () => {
		const tools = captureTools(stubDeps());
		expect(tools.get("fetch_lyrics")!.schema.description.length).toBeGreaterThan(0);
		expect(tools.get("save_listening_fact")!.schema.description.length).toBeGreaterThan(0);
	});
});

// ─── fetch_lyrics input schema ──────────────────────────────────

describe("fetch_lyrics — input schema", () => {
	let schema: Record<string, z.ZodType>;
	beforeEach(() => {
		const tools = captureTools(stubDeps());
		schema = tools.get("fetch_lyrics")!.schema.inputSchema;
	});

	test("title は string", () => {
		expect(schema.title!.safeParse("ok").success).toBe(true);
		expect(schema.title!.safeParse(123).success).toBe(false);
	});

	test("artist は string", () => {
		expect(schema.artist!.safeParse("ok").success).toBe(true);
		expect(schema.artist!.safeParse(null).success).toBe(false);
	});

	test("title / artist の 2 フィールドのみを持つ", () => {
		expect(Object.keys(schema).toSorted()).toEqual(["artist", "title"]);
	});
});

// ─── fetch_lyrics handler ───────────────────────────────────────

describe("fetch_lyrics — handler", () => {
	test("deps.fetchLyrics が title / artist をそのまま受け取る", async () => {
		const calls: Array<{ title: string; artist: string }> = [];
		const tools = captureTools(
			stubDeps({
				fetchLyrics: (title, artist) => {
					calls.push({ title, artist });
					return Promise.resolve("l");
				},
			}),
		);

		await tools.get("fetch_lyrics")!.handler({ title: "夜に駆ける", artist: "YOASOBI" });

		expect(calls).toEqual([{ title: "夜に駆ける", artist: "YOASOBI" }]);
	});

	test("成功時: 歌詞を text として返し isError は undefined", async () => {
		const tools = captureTools(stubDeps({ fetchLyrics: () => Promise.resolve("これは歌詞") }));

		const result = await tools.get("fetch_lyrics")!.handler({ title: "a", artist: "b" });

		expect(result.content[0]!.type).toBe("text");
		expect(result.content[0]!.text).toBe("これは歌詞");
		expect(result.isError).toBeUndefined();
	});

	test("null 返却時: 歌詞なしを示すテキストを返す（title / artist を含む）", async () => {
		const tools = captureTools(stubDeps({ fetchLyrics: () => Promise.resolve(null) }));

		const result = await tools.get("fetch_lyrics")!.handler({ title: "X", artist: "Y" });

		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("X");
		expect(result.content[0]!.text).toContain("Y");
	});

	test("例外時: isError=true を返し text にエラー文字列を含む", async () => {
		const tools = captureTools(stubDeps({ fetchLyrics: () => Promise.reject(new Error("boom")) }));

		const result = await tools.get("fetch_lyrics")!.handler({ title: "a", artist: "b" });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("boom");
	});

	test("空文字の歌詞も text として返る（null ではない扱い）", async () => {
		const tools = captureTools(stubDeps({ fetchLyrics: () => Promise.resolve("") }));

		const result = await tools.get("fetch_lyrics")!.handler({ title: "a", artist: "b" });

		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toBe("");
	});
});

// ─── save_listening_fact input schema ───────────────────────────

describe("save_listening_fact — input schema", () => {
	let schema: Record<string, z.ZodType>;
	beforeEach(() => {
		const tools = captureTools(stubDeps());
		schema = tools.get("save_listening_fact")!.schema.inputSchema;
	});

	test("track は record<string, unknown>", () => {
		expect(schema.track!.safeParse({ a: 1, b: "s" }).success).toBe(true);
		expect(schema.track!.safeParse({}).success).toBe(true);
		expect(schema.track!.safeParse("string").success).toBe(false);
		expect(schema.track!.safeParse(null).success).toBe(false);
	});

	test("impression は string", () => {
		expect(schema.impression!.safeParse("感想").success).toBe(true);
		expect(schema.impression!.safeParse(42).success).toBe(false);
	});

	test("track / impression の 2 フィールドのみ持つ", () => {
		expect(Object.keys(schema).toSorted()).toEqual(["impression", "track"]);
	});
});

// ─── save_listening_fact handler ────────────────────────────────

describe("save_listening_fact — handler", () => {
	test("deps.saveListening に track と impression が渡される", async () => {
		const calls: Array<{
			track: Record<string, unknown>;
			impression: string;
			listenedAt: Date;
		}> = [];
		const tools = captureTools(
			stubDeps({
				saveListening: (r) => {
					calls.push(r);
					return Promise.resolve();
				},
			}),
		);

		const track = { id: "t-1", name: "曲", artistName: "A" };
		await tools.get("save_listening_fact")!.handler({ track, impression: "好き" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.track).toEqual(track);
		expect(calls[0]?.impression).toBe("好き");
	});

	test("listenedAt には new Date() が付与される（現在時刻に近い）", async () => {
		const calls: Array<{ listenedAt: Date }> = [];
		const tools = captureTools(
			stubDeps({
				saveListening: (r) => {
					calls.push({ listenedAt: r.listenedAt });
					return Promise.resolve();
				},
			}),
		);

		const before = Date.now();
		await tools.get("save_listening_fact")!.handler({ track: {}, impression: "x" });
		const after = Date.now();

		expect(calls[0]?.listenedAt).toBeInstanceOf(Date);
		const t = calls[0]!.listenedAt.getTime();
		expect(t).toBeGreaterThanOrEqual(before);
		expect(t).toBeLessThanOrEqual(after);
	});

	test("成功時: isError は undefined で成功テキストが返る", async () => {
		const tools = captureTools(stubDeps());

		const result = await tools.get("save_listening_fact")!.handler({ track: {}, impression: "x" });

		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.type).toBe("text");
		expect(result.content[0]!.text.length).toBeGreaterThan(0);
	});

	test("例外時: isError=true を返し text にエラー文字列を含む", async () => {
		const tools = captureTools(
			stubDeps({ saveListening: () => Promise.reject(new Error("db err")) }),
		);

		const result = await tools.get("save_listening_fact")!.handler({ track: {}, impression: "x" });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("db err");
	});

	test("track はネストしたオブジェクトでもそのまま渡される", async () => {
		const calls: Array<{ track: Record<string, unknown> }> = [];
		const tools = captureTools(
			stubDeps({
				saveListening: (r) => {
					calls.push({ track: r.track });
					return Promise.resolve();
				},
			}),
		);

		const track = {
			id: "t",
			album: { name: "A", images: [{ url: "u" }] },
			genres: ["pop", "rock"],
		};
		await tools.get("save_listening_fact")!.handler({ track, impression: "感想" });

		expect(calls[0]?.track).toEqual(track);
	});
});
