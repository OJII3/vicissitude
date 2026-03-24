import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, rmSync } from "fs";

import type {
	GuildInstance,
	GuildInstanceFactory,
} from "@vicissitude/memory/conversation-recorder";
import { MemoryConversationRecorder } from "@vicissitude/memory/conversation-recorder";
import type { Episode } from "@vicissitude/memory/episode";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";

const TEMP_DIR = `/tmp/vicissitude-memory-test-${process.pid}`;

afterEach(() => {
	if (existsSync(TEMP_DIR)) {
		rmSync(TEMP_DIR, { recursive: true, force: true });
	}
});

const mockAddMessage = mock((): Promise<Episode[]> => Promise.resolve([]));
const mockConsolidate = mock(() =>
	Promise.resolve({
		processedEpisodes: 3,
		newFacts: 1,
		reinforced: 1,
		updated: 0,
		invalidated: 0,
	}),
);
const mockStorageClose = mock(() => {});

const mockFactory: GuildInstanceFactory = (): GuildInstance => ({
	segmenter: { addMessage: mockAddMessage },
	storage: { close: mockStorageClose },
	consolidation: { consolidate: mockConsolidate },
});

function createRecorder() {
	const llm = {} as MemoryLlmPort;
	return new MemoryConversationRecorder(llm, TEMP_DIR, mockFactory);
}

const sampleMessage = {
	role: "user" as const,
	content: "hello",
	name: "alice",
	timestamp: new Date(),
};

describe("MemoryConversationRecorder", () => {
	test("record() で guildId が非数字 → Error throw", async () => {
		const recorder = createRecorder();
		await expect(recorder.record("abc", sampleMessage)).rejects.toThrow("Invalid guildId: abc");
	});

	test("record() で segmenter.addMessage 呼び出し確認", async () => {
		mockAddMessage.mockClear();
		const recorder = createRecorder();
		await recorder.record("12345", sampleMessage);

		expect(mockAddMessage).toHaveBeenCalledTimes(1);
		expect(mockAddMessage).toHaveBeenCalledWith("12345", {
			role: "user",
			content: "hello",
			name: "alice",
			timestamp: sampleMessage.timestamp,
		});
	});

	test("同一 guild への record() 2 回 → 直列実行（ロック）", async () => {
		mockAddMessage.mockClear();
		const order: number[] = [];
		let resolveFirst!: () => void;
		let callCount = 0;

		mockAddMessage.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return new Promise<Episode[]>((resolve) => {
					resolveFirst = () => {
						order.push(1);
						resolve([]);
					};
				});
			}
			order.push(2);
			return Promise.resolve([]);
		});

		const recorder = createRecorder();
		const p1 = recorder.record("111", sampleMessage);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 10);
		});
		const p2 = recorder.record("111", sampleMessage);

		resolveFirst();
		await p1;
		await p2;

		expect(order).toEqual([1, 2]);
	});

	test("getActiveGuildIds() → 初期化済みギルドのみ返す", async () => {
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		const recorder = createRecorder();

		expect(recorder.getActiveGuildIds()).toEqual([]);

		await recorder.record("100", sampleMessage);
		await recorder.record("200", sampleMessage);

		const ids = recorder.getActiveGuildIds();
		expect(ids).toContain("100");
		expect(ids).toContain("200");
		expect(ids).toHaveLength(2);
	});

	test("consolidate() で未初期化 guild → 0 initialized result", async () => {
		const recorder = createRecorder();

		const result = await recorder.consolidate("99999");
		expect(result).toEqual({
			processedEpisodes: 0,
			newFacts: 0,
			reinforced: 0,
			updated: 0,
			invalidated: 0,
		});
	});

	test("consolidate() で guildId が非数字 → Error throw", () => {
		const recorder = createRecorder();
		expect(() => recorder.consolidate("invalid")).toThrow("Invalid guildId: invalid");
	});

	test("consolidate() で初期化済み guild → pipeline.consolidate 呼び出し", async () => {
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		mockConsolidate.mockClear();
		const recorder = createRecorder();

		await recorder.record("555", sampleMessage);

		const result = await recorder.consolidate("555");
		expect(mockConsolidate).toHaveBeenCalledWith("555");
		expect(result.processedEpisodes).toBe(3);
	});

	test("close() → 全ロック完了 + storage.close() 呼び出し", async () => {
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		mockStorageClose.mockClear();
		const recorder = createRecorder();

		await recorder.record("777", sampleMessage);
		await recorder.close();

		expect(mockStorageClose).toHaveBeenCalled();
		expect(recorder.getActiveGuildIds()).toEqual([]);
	});
});
