import { describe, expect, mock, test } from "bun:test";

import { createMockLogger } from "@vicissitude/shared/test-helpers";
import type { OpencodeSessionPort } from "@vicissitude/shared/types";

import { ImageAttachmentDescriber } from "./image-attachment-describer.ts";

function createSessionPort(): OpencodeSessionPort & {
	createSession: ReturnType<typeof mock>;
	prompt: ReturnType<typeof mock>;
	deleteSession: ReturnType<typeof mock>;
} {
	return {
		createSession: mock(() => Promise.resolve("vision-session")),
		sessionExists: mock(() => Promise.resolve(true)),
		prompt: mock(() => Promise.resolve({ text: "画像1 (photo.png): 猫が写っている。" })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => Promise.resolve({ type: "idle" as const })),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		summarizeSession: mock(() => Promise.resolve()),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	};
}

describe("ImageAttachmentDescriber", () => {
	test("画像添付を観察結果として本文へ追加し、通常モデルへ渡す attachments から画像を除外する", async () => {
		const sessionPort = createSessionPort();
		const describer = new ImageAttachmentDescriber({
			sessionPort,
			model: { providerId: "vision-provider", modelId: "vision-model" },
			logger: createMockLogger(),
		});

		const image = {
			url: "https://example.com/photo.png",
			contentType: "image/png",
			filename: "photo.png",
		};
		const textFile = {
			url: "https://example.com/memo.txt",
			contentType: "text/plain",
			filename: "memo.txt",
		};

		const result = await describer.process("hello", [image, textFile]);

		expect(result.text).toContain("<attachment_descriptions>");
		expect(result.text).toContain("猫が写っている");
		expect(result.attachments).toEqual([textFile]);
		expect(sessionPort.createSession).toHaveBeenCalledWith("discord-image-recognition");
		expect(sessionPort.prompt).toHaveBeenCalledWith({
			sessionId: "vision-session",
			text: expect.stringContaining('filename="photo.png"'),
			model: { providerId: "vision-provider", modelId: "vision-model" },
			tools: {},
			attachments: [image],
		});
		expect(sessionPort.deleteSession).toHaveBeenCalledWith("vision-session");
	});

	test("画像添付がない場合は vision session を作らない", async () => {
		const sessionPort = createSessionPort();
		const describer = new ImageAttachmentDescriber({
			sessionPort,
			model: { providerId: "vision-provider", modelId: "vision-model" },
		});
		const attachment = {
			url: "https://example.com/memo.txt",
			contentType: "text/plain",
			filename: "memo.txt",
		};

		const result = await describer.process("hello", [attachment]);

		expect(result).toEqual({ text: "hello", attachments: [attachment] });
		expect(sessionPort.createSession).not.toHaveBeenCalled();
		expect(sessionPort.prompt).not.toHaveBeenCalled();
	});
});
