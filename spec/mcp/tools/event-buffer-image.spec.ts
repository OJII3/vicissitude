import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEventBufferTools } from "@vicissitude/mcp/tools/event-buffer";
import type { FetchedImage, ImageFetcher } from "@vicissitude/shared/ports";
import { appendEvent } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";

// wait_for_events のレスポンスは text と image が混在する（TextContent | ImageContent）。
// spec では両方を緩く受けられる union 型で宣言する。
type ContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/** registerEventBufferTools で登録された wait_for_events を直接呼び出すヘルパー */
async function callWaitForEvents(
	deps: Parameters<typeof registerEventBufferTools>[1],
): Promise<{ content: ContentPart[] }> {
	let registeredHandler: ((args: { timeout_seconds: number }) => Promise<unknown>) | undefined;

	const fakeServer = {
		registerTool(
			_name: string,
			_schema: unknown,
			handler: (args: { timeout_seconds: number }) => Promise<unknown>,
		) {
			registeredHandler = handler;
		},
	} as unknown as McpServer;

	registerEventBufferTools(fakeServer, deps);

	if (!registeredHandler) throw new Error("handler not registered");
	return (await registeredHandler({ timeout_seconds: 5 })) as { content: ContentPart[] };
}

function insertEventWithImages(
	db: ReturnType<typeof createTestDb>,
	agentId: string,
	attachments: { url: string; contentType?: string; filename?: string }[],
): void {
	appendEvent(
		db,
		agentId,
		JSON.stringify({
			ts: "2026-04-01T00:00:00.000Z",
			content: "画像添付",
			authorId: "user-1",
			authorName: "テスト",
			messageId: `msg-${attachments.map((a) => a.filename ?? "").join("-")}`,
			attachments,
			metadata: { channelId: "ch-1", channelName: "general", isMentioned: true },
		}),
	);
}

/** 固定の base64/mime を返すスタブ ImageFetcher */
function createStubImageFetcher(response: FetchedImage | null): {
	fetcher: ImageFetcher;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		fetcher: {
			fetch: (url: string) => {
				calls.push(url);
				return Promise.resolve(response);
			},
		},
		calls,
	};
}

/** URL ごとに異なるレスポンスを返すスタブ ImageFetcher */
function createMappedImageFetcher(mapping: Record<string, FetchedImage | null>): {
	fetcher: ImageFetcher;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		fetcher: {
			fetch: (url: string) => {
				calls.push(url);
				return Promise.resolve(mapping[url] ?? null);
			},
		},
		calls,
	};
}

function isImagePart(c: ContentPart): c is { type: "image"; data: string; mimeType: string } {
	return c.type === "image";
}

/** 仕様で定める 1 応答あたりの画像上限。実装側の定数に依存しないようハードコードする。 */
const EXPECTED_MAX_IMAGES = 4;

describe("wait_for_events への画像同梱", () => {
	test("imageFetcher があれば image content part が content 配列に含まれる", async () => {
		const db = createTestDb();
		const agentId = "agent-img-1";
		insertEventWithImages(db, agentId, [
			{ url: "https://cdn.example.com/a.png", contentType: "image/png", filename: "a.png" },
		]);

		const { fetcher, calls } = createStubImageFetcher({ base64: "BASE64A", mimeType: "image/png" });

		const result = await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		const images = result.content.filter(isImagePart);
		expect(images).toHaveLength(1);
		const [first] = images;
		if (!first) throw new Error("expected first image part");
		expect(first.data).toBe("BASE64A");
		expect(first.mimeType).toBe("image/png");
		expect(calls).toEqual(["https://cdn.example.com/a.png"]);
	});

	test("imageFetcher が無ければ image content part は生成されない", async () => {
		const db = createTestDb();
		const agentId = "agent-img-2";
		insertEventWithImages(db, agentId, [
			{ url: "https://cdn.example.com/a.png", contentType: "image/png", filename: "a.png" },
		]);

		const result = await callWaitForEvents({ db, agentId });

		expect(result.content.some(isImagePart)).toBe(false);
	});

	test("非画像 MIME の添付は fetch されない", async () => {
		const db = createTestDb();
		const agentId = "agent-img-3";
		insertEventWithImages(db, agentId, [
			{
				url: "https://cdn.example.com/doc.pdf",
				contentType: "application/pdf",
				filename: "doc.pdf",
			},
			{ url: "https://cdn.example.com/img.png", contentType: "image/png", filename: "img.png" },
		]);

		const { fetcher, calls } = createStubImageFetcher({ base64: "PNG", mimeType: "image/png" });
		await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		// PDF は image/ prefix に該当しないので fetcher は呼ばれない
		expect(calls).toEqual(["https://cdn.example.com/img.png"]);
	});

	test(`1 回の応答に同梱する画像は最大 ${EXPECTED_MAX_IMAGES} 枚に制限される`, async () => {
		const db = createTestDb();
		const agentId = "agent-img-4";
		const overflow = EXPECTED_MAX_IMAGES + 2;
		const attachments = Array.from({ length: overflow }, (_, i) => ({
			url: `https://cdn.example.com/img-${i}.png`,
			contentType: "image/png",
			filename: `img-${i}.png`,
		}));
		insertEventWithImages(db, agentId, attachments);

		const { fetcher, calls } = createStubImageFetcher({ base64: "DATA", mimeType: "image/png" });
		const result = await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		// 上限を超えた URL は fetch されず、image part も生成されない
		expect(calls).toHaveLength(EXPECTED_MAX_IMAGES);
		expect(result.content.filter(isImagePart)).toHaveLength(EXPECTED_MAX_IMAGES);
		// text 側には全ての filename が列挙される（LLM が「超過した画像もあった」ことを認識できるように）
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		for (let i = 0; i < overflow; i++) {
			expect(text).toContain(`img-${i}.png`);
		}
	});

	test("fetch 失敗時は image part を省略し、text 表記だけで LLM に渡る", async () => {
		const db = createTestDb();
		const agentId = "agent-img-5";
		insertEventWithImages(db, agentId, [
			{
				url: "https://cdn.example.com/broken.png",
				contentType: "image/png",
				filename: "broken.png",
			},
		]);

		const { fetcher } = createStubImageFetcher(null);
		const result = await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		expect(result.content.some(isImagePart)).toBe(false);
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		// filename は text 側に残るので、LLM は「添付はあったが見えない」ことを認識できる
		expect(text).toContain("broken.png");
	});

	test("複数イベントに跨る画像添付も出現順に同梱される", async () => {
		const db = createTestDb();
		const agentId = "agent-img-6";
		insertEventWithImages(db, agentId, [
			{ url: "https://cdn.example.com/e1a.png", contentType: "image/png", filename: "e1a.png" },
		]);
		insertEventWithImages(db, agentId, [
			{ url: "https://cdn.example.com/e2a.png", contentType: "image/png", filename: "e2a.png" },
			{ url: "https://cdn.example.com/e2b.png", contentType: "image/png", filename: "e2b.png" },
		]);

		const { fetcher, calls } = createStubImageFetcher({ base64: "X", mimeType: "image/png" });
		await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		expect(calls).toEqual([
			"https://cdn.example.com/e1a.png",
			"https://cdn.example.com/e2a.png",
			"https://cdn.example.com/e2b.png",
		]);
	});

	test("各イベントの image parts はそのイベントの text part の直後に配置される", async () => {
		const db = createTestDb();
		const agentId = "agent-img-order";
		insertEventWithImages(db, agentId, [
			{
				url: "https://cdn.example.com/order1.png",
				contentType: "image/png",
				filename: "order1.png",
			},
			{
				url: "https://cdn.example.com/order2.png",
				contentType: "image/png",
				filename: "order2.png",
			},
		]);

		const { fetcher } = createMappedImageFetcher({
			"https://cdn.example.com/order1.png": { base64: "ORDER1", mimeType: "image/png" },
			"https://cdn.example.com/order2.png": { base64: "ORDER2", mimeType: "image/png" },
		});
		const result = await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		// イベントの text part を特定（order1.png, order2.png を含む text）
		const eventTextIndex = result.content.findIndex(
			(c) => c.type === "text" && "text" in c && c.text.includes("order1.png"),
		);
		expect(eventTextIndex).toBeGreaterThan(-1);

		// そのイベントの text part の直後に image parts が来る
		const afterEvent = result.content.slice(eventTextIndex + 1);
		const firstImage = afterEvent.find((c) => isImagePart(c));
		expect(firstImage).toBeDefined();

		// image parts はイベント text part と metadata text part の間に存在する
		const images = result.content.filter(isImagePart);
		expect(images).toHaveLength(2);
	});

	test("複数イベントの画像がイベント単位でインターリーブ配置される", async () => {
		const db = createTestDb();
		const agentId = "agent-img-interleave";
		// イベント1: 画像A
		insertEventWithImages(db, agentId, [
			{ url: "https://cdn.example.com/a.png", contentType: "image/png", filename: "a.png" },
		]);
		// イベント2: 画像B, C
		insertEventWithImages(db, agentId, [
			{ url: "https://cdn.example.com/b.png", contentType: "image/png", filename: "b.png" },
			{ url: "https://cdn.example.com/c.png", contentType: "image/png", filename: "c.png" },
		]);

		const { fetcher } = createMappedImageFetcher({
			"https://cdn.example.com/a.png": { base64: "IMG_A", mimeType: "image/png" },
			"https://cdn.example.com/b.png": { base64: "IMG_B", mimeType: "image/png" },
			"https://cdn.example.com/c.png": { base64: "IMG_C", mimeType: "image/png" },
		});
		const result = await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		// content 配列から event text / image の並びを検証する
		// 期待: [...prefix_texts, event1_text, imageA, event2_text, imageB, imageC, metadata_text]
		const parts = result.content;

		// event1 の text part を特定（a.png を含む）
		const e1TextIdx = parts.findIndex(
			(c) =>
				c.type === "text" && "text" in c && c.text.includes("a.png") && !c.text.includes("b.png"),
		);
		expect(e1TextIdx).toBeGreaterThan(-1);

		// event1 text の直後に event1 の image (IMG_A) が来る
		const afterE1 = parts.at(e1TextIdx + 1);
		expect(afterE1).toBeDefined();
		expect(afterE1?.type).toBe("image");
		expect(afterE1 && isImagePart(afterE1) && afterE1.data).toBe("IMG_A");

		// event2 の text part を特定（b.png を含む）
		const e2TextIdx = parts.findIndex(
			(c) => c.type === "text" && "text" in c && c.text.includes("b.png"),
		);
		expect(e2TextIdx).toBeGreaterThan(-1);
		// event2 text は event1 image の後に来る
		expect(e2TextIdx).toBeGreaterThan(e1TextIdx + 1);

		// event2 text の直後に event2 の images (IMG_B, IMG_C) が来る
		const afterE2First = parts.at(e2TextIdx + 1);
		const afterE2Second = parts.at(e2TextIdx + 2);
		expect(afterE2First).toBeDefined();
		expect(afterE2Second).toBeDefined();
		expect(afterE2First?.type).toBe("image");
		expect(afterE2Second?.type).toBe("image");
		expect(afterE2First && isImagePart(afterE2First) && afterE2First.data).toBe("IMG_B");
		expect(afterE2Second && isImagePart(afterE2Second) && afterE2Second.data).toBe("IMG_C");

		// metadata text は最後の text part
		const lastPart = parts.at(-1);
		expect(lastPart).toBeDefined();
		expect(lastPart?.type).toBe("text");
		expect(lastPart && "text" in lastPart && lastPart.text).toContain("event-metadata");
	});

	test("画像のないイベントは text part のみで image part が挟まらない", async () => {
		const db = createTestDb();
		const agentId = "agent-img-no-img-event";
		// イベント1: 画像あり
		insertEventWithImages(db, agentId, [
			{ url: "https://cdn.example.com/x.png", contentType: "image/png", filename: "x.png" },
		]);
		// イベント2: 画像なし
		appendEvent(
			db,
			agentId,
			JSON.stringify({
				ts: "2026-04-01T00:01:00.000Z",
				content: "テキストのみ",
				authorId: "user-2",
				authorName: "ユーザー2",
				messageId: "msg-no-img",
				attachments: [],
				metadata: { channelId: "ch-1", channelName: "general", isMentioned: true },
			}),
		);
		// イベント3: 画像あり
		insertEventWithImages(db, agentId, [
			{ url: "https://cdn.example.com/y.png", contentType: "image/png", filename: "y.png" },
		]);

		const { fetcher } = createMappedImageFetcher({
			"https://cdn.example.com/x.png": { base64: "IMG_X", mimeType: "image/png" },
			"https://cdn.example.com/y.png": { base64: "IMG_Y", mimeType: "image/png" },
		});
		const result = await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		const parts = result.content;

		// event1 text (x.png を含む) の直後に IMG_X が来る
		const e1TextIdx = parts.findIndex(
			(c) =>
				c.type === "text" &&
				"text" in c &&
				c.text.includes("x.png") &&
				!c.text.includes("テキストのみ"),
		);
		expect(e1TextIdx).toBeGreaterThan(-1);
		const afterE1 = parts.at(e1TextIdx + 1);
		expect(afterE1).toBeDefined();
		expect(afterE1?.type).toBe("image");
		expect(afterE1 && isImagePart(afterE1) && afterE1.data).toBe("IMG_X");

		// event2 text (テキストのみ) の直後は image ではない
		const e2TextIdx = parts.findIndex(
			(c) => c.type === "text" && "text" in c && c.text.includes("テキストのみ"),
		);
		expect(e2TextIdx).toBeGreaterThan(-1);
		const afterE2 = parts.at(e2TextIdx + 1);
		expect(afterE2).toBeDefined();
		// event2 の直後は image part ではなく、event3 の text part であるべき
		expect(afterE2?.type).toBe("text");

		// event3 text (y.png を含む) の直後に IMG_Y が来る
		const e3TextIdx = parts.findIndex(
			(c, i) => i > e2TextIdx && c.type === "text" && "text" in c && c.text.includes("y.png"),
		);
		expect(e3TextIdx).toBeGreaterThan(-1);
		const afterE3 = parts.at(e3TextIdx + 1);
		expect(afterE3).toBeDefined();
		expect(afterE3?.type).toBe("image");
		expect(afterE3 && isImagePart(afterE3) && afterE3.data).toBe("IMG_Y");
	});
});
