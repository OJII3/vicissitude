import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, rmSync } from "fs";

import type {
	GuildInstance,
	GuildInstanceFactory,
} from "@vicissitude/memory/conversation-recorder";
import { MemoryConversationRecorder } from "@vicissitude/memory/conversation-recorder";
import type { Episode } from "@vicissitude/memory/episode";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import {
	discordGuildNamespace,
	HUA_SELF_SUBJECT,
	INTERNAL_NAMESPACE,
} from "@vicissitude/memory/namespace";

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

describe("MemoryConversationRecorder (namespace API)", () => {
	test("record() で不正 guildId の namespace 生成 → throw (at factory)", () => {
		// discord-guild namespace は生成時点で guildId をバリデートする
		expect(() => discordGuildNamespace("abc")).toThrow(/guildId/i);
	});

	test("record() で segmenter.addMessage が defaultSubject で呼ばれる（discord-guild）", async () => {
		mockAddMessage.mockClear();
		const recorder = createRecorder();
		const ns = discordGuildNamespace("12345");
		await recorder.record(ns, sampleMessage);

		expect(mockAddMessage).toHaveBeenCalledTimes(1);
		// discord-guild の defaultSubject は guildId（既存互換）
		expect(mockAddMessage).toHaveBeenCalledWith("12345", {
			role: "user",
			content: "hello",
			name: "alice",
			timestamp: sampleMessage.timestamp,
		});
	});

	test("record() で internal namespace → subject は HUA_SELF_SUBJECT", async () => {
		mockAddMessage.mockClear();
		const recorder = createRecorder();
		await recorder.record(INTERNAL_NAMESPACE, sampleMessage);

		expect(mockAddMessage).toHaveBeenCalledTimes(1);
		expect(mockAddMessage).toHaveBeenCalledWith(HUA_SELF_SUBJECT, {
			role: "user",
			content: "hello",
			name: "alice",
			timestamp: sampleMessage.timestamp,
		});
	});

	test("同一 namespace への record() 2 回 → 直列実行（ロック）", async () => {
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
		const ns = discordGuildNamespace("111");
		const p1 = recorder.record(ns, sampleMessage);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 10);
		});
		const p2 = recorder.record(ns, sampleMessage);

		resolveFirst();
		await p1;
		await p2;

		expect(order).toEqual([1, 2]);
	});

	test("異なる namespace は独立してロックされる", async () => {
		// discord-guild:111 と internal は独立したインスタンスを持つ
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		const recorder = createRecorder();

		await recorder.record(discordGuildNamespace("111"), sampleMessage);
		await recorder.record(INTERNAL_NAMESPACE, sampleMessage);

		const namespaces = recorder.getActiveNamespaces();
		expect(namespaces).toHaveLength(2);
	});

	test("getActiveNamespaces() → 初期化済み namespace のみ返す", async () => {
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		const recorder = createRecorder();

		expect(recorder.getActiveNamespaces()).toEqual([]);

		await recorder.record(discordGuildNamespace("100"), sampleMessage);
		await recorder.record(discordGuildNamespace("200"), sampleMessage);

		const namespaces = recorder.getActiveNamespaces();
		expect(namespaces).toHaveLength(2);
		expect(namespaces.some((ns) => ns.surface === "discord-guild" && ns.guildId === "100")).toBe(
			true,
		);
		expect(namespaces.some((ns) => ns.surface === "discord-guild" && ns.guildId === "200")).toBe(
			true,
		);
	});

	test("getActiveNamespaces() には internal namespace も含まれる", async () => {
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		const recorder = createRecorder();

		await recorder.record(INTERNAL_NAMESPACE, sampleMessage);

		const namespaces = recorder.getActiveNamespaces();
		expect(namespaces).toHaveLength(1);
		expect(namespaces[0]).toEqual(INTERNAL_NAMESPACE);
	});

	test("consolidate() で未初期化 namespace → 0 initialized result", async () => {
		const recorder = createRecorder();

		const result = await recorder.consolidate(discordGuildNamespace("99999"));
		expect(result).toEqual({
			processedEpisodes: 0,
			newFacts: 0,
			reinforced: 0,
			updated: 0,
			invalidated: 0,
		});
	});

	test("consolidate() で初期化済み namespace → pipeline.consolidate 呼び出し（subject 渡し）", async () => {
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		mockConsolidate.mockClear();
		const recorder = createRecorder();
		const ns = discordGuildNamespace("555");

		await recorder.record(ns, sampleMessage);

		const result = await recorder.consolidate(ns);
		// consolidation は defaultSubject(ns) = "555" で呼ばれる
		expect(mockConsolidate).toHaveBeenCalledWith("555");
		expect(result.processedEpisodes).toBe(3);
	});

	test("consolidate() で internal namespace → HUA_SELF_SUBJECT で呼ばれる", async () => {
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		mockConsolidate.mockClear();
		const recorder = createRecorder();

		await recorder.record(INTERNAL_NAMESPACE, sampleMessage);
		await recorder.consolidate(INTERNAL_NAMESPACE);

		expect(mockConsolidate).toHaveBeenCalledWith(HUA_SELF_SUBJECT);
	});

	test("close() → 全ロック完了 + storage.close() 呼び出し", async () => {
		mockAddMessage.mockClear();
		mockAddMessage.mockImplementation(() => Promise.resolve([]));
		mockStorageClose.mockClear();
		const recorder = createRecorder();

		await recorder.record(discordGuildNamespace("777"), sampleMessage);
		await recorder.close();

		expect(mockStorageClose).toHaveBeenCalled();
		expect(recorder.getActiveNamespaces()).toEqual([]);
	});
});
