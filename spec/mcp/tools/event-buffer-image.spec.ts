import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	MAX_IMAGES_PER_RESPONSE,
	registerEventBufferTools,
} from "@vicissitude/mcp/tools/event-buffer";
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

function isImagePart(c: ContentPart): c is { type: "image"; data: string; mimeType: string } {
	return c.type === "image";
}

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

	test(`1 回の応答に同梱する画像は最大 ${MAX_IMAGES_PER_RESPONSE} 枚に制限される`, async () => {
		const db = createTestDb();
		const agentId = "agent-img-4";
		const overflow = MAX_IMAGES_PER_RESPONSE + 2;
		const attachments = Array.from({ length: overflow }, (_, i) => ({
			url: `https://cdn.example.com/img-${i}.png`,
			contentType: "image/png",
			filename: `img-${i}.png`,
		}));
		insertEventWithImages(db, agentId, attachments);

		const { fetcher, calls } = createStubImageFetcher({ base64: "DATA", mimeType: "image/png" });
		const result = await callWaitForEvents({ db, agentId, imageFetcher: fetcher });

		// 上限を超えた URL は fetch されず、image part も生成されない
		expect(calls).toHaveLength(MAX_IMAGES_PER_RESPONSE);
		expect(result.content.filter(isImagePart)).toHaveLength(MAX_IMAGES_PER_RESPONSE);
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
});
