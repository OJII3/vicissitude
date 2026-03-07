import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import type { BufferedEvent } from "../../domain/ports/event-buffer.port.ts";
import { FileEventBuffer } from "./file-event-buffer.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = resolve(
		tmpdir(),
		`event-buffer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	tempDirs.push(dir);
	return dir;
}

function createEvent(overrides?: Partial<BufferedEvent>): BufferedEvent {
	return {
		ts: "2026-03-02T12:00:00.000Z",
		channelId: "ch-123",
		guildId: "guild-456",
		authorId: "user-789",
		authorName: "TestUser",
		messageId: "msg-001",
		content: "テストメッセージ",
		isBot: false,
		isMentioned: false,
		isThread: false,
		...overrides,
	};
}

afterEach(() => {
	for (const dir of tempDirs) {
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true });
		}
	}
	tempDirs.length = 0;
});

describe("FileEventBuffer", () => {
	it("ディレクトリが存在しない場合に自動作成される", () => {
		const dir = createTempDir();
		const _buffer = new FileEventBuffer(dir);
		expect(existsSync(dir)).toBe(true);
	});

	it("初回 append でファイルが作成される", async () => {
		const dir = createTempDir();
		const buffer = new FileEventBuffer(dir);
		const filePath = resolve(dir, "events.jsonl");

		await buffer.append(createEvent());

		expect(existsSync(filePath)).toBe(true);
		const content = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content.trim());
		expect(parsed.channelId).toBe("ch-123");
		expect(parsed.content).toBe("テストメッセージ");
	});

	it("複数回 append で追記される", async () => {
		const dir = createTempDir();
		const buffer = new FileEventBuffer(dir);
		const filePath = resolve(dir, "events.jsonl");

		await buffer.append(createEvent({ messageId: "msg-001" }));
		await buffer.append(createEvent({ messageId: "msg-002" }));
		await buffer.append(createEvent({ messageId: "msg-003" }));

		const lines = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim() !== "");
		expect(lines).toHaveLength(3);

		const events = lines.map((l) => JSON.parse(l));
		expect(events[0].messageId).toBe("msg-001");
		expect(events[1].messageId).toBe("msg-002");
		expect(events[2].messageId).toBe("msg-003");
	});

	it("各行が有効な JSON である", async () => {
		const dir = createTempDir();
		const buffer = new FileEventBuffer(dir);
		const filePath = resolve(dir, "events.jsonl");

		await buffer.append(createEvent({ content: "日本語テスト 🎉" }));

		const line = readFileSync(filePath, "utf-8").trim();
		expect(() => JSON.parse(line)).not.toThrow();
		expect(JSON.parse(line).content).toBe("日本語テスト 🎉");
	});
});

describe("FileEventBuffer.waitForEvents", () => {
	it("既にイベントがある場合、即座に resolve する", async () => {
		const dir = createTempDir();
		const buffer = new FileEventBuffer(dir);
		await buffer.append(createEvent());

		const ac = new AbortController();
		await buffer.waitForEvents(ac.signal);
		ac.abort();
		// waitForEvents が即座に resolve すればテスト成功
	});

	it("AbortSignal.abort() で即座に resolve する", async () => {
		const dir = createTempDir();
		const buffer = new FileEventBuffer(dir);

		const ac = new AbortController();
		const promise = buffer.waitForEvents(ac.signal);
		ac.abort();
		await promise;
		// abort 後にハングしなければテスト成功
	});

	it("既に abort 済みの signal で即座に resolve する", async () => {
		const dir = createTempDir();
		const buffer = new FileEventBuffer(dir);

		await buffer.waitForEvents(AbortSignal.abort());
	});

	it("append() が呼ばれたら resolve する", async () => {
		const dir = createTempDir();
		const buffer = new FileEventBuffer(dir);

		const ac = new AbortController();
		const promise = buffer.waitForEvents(ac.signal);

		// 少し遅延してから append
		setTimeout(() => buffer.append(createEvent()), 50);

		await promise;
		ac.abort();
		// append 後に waitForEvents が resolve すればテスト成功
	});
});
