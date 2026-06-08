import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Emotion } from "@vicissitude/shared/emotion";
import { NEUTRAL_EMOTION, createEmotion } from "@vicissitude/shared/emotion";
import type { MoodReader } from "@vicissitude/shared/ports";

import {
	MoodNicknameService,
	extractBaseName,
	formatMoodNickname,
} from "../../apps/discord/src/mood-nickname.ts";
import { createMockLogger } from "../test-helpers.ts";

// ─── Test Helpers ──────────────────────────────────────────────────

function createMockGateway() {
	return {
		setGuildNickname: mock(async (_guildId: string, _nickname: string | null) => {}),
	};
}

function createMockMoodReader(moodMap: Record<string, Emotion>): MoodReader {
	return {
		getMood: (agentId: string) => moodMap[agentId] ?? NEUTRAL_EMOTION,
	};
}

// ─── extractBaseName ───────────────────────────────────────────────

describe("extractBaseName", () => {
	test("末尾の @xxx を除去してベース名を返す", () => {
		expect(extractBaseName("ふあ @happy")).toBe("ふあ");
	});

	test("@xxx がない場合はそのまま返す", () => {
		expect(extractBaseName("ふあ")).toBe("ふあ");
	});

	test("複数単語のベース名でも正しく動作する", () => {
		expect(extractBaseName("Test Bot @surprised")).toBe("Test Bot");
	});

	test("末尾の空白をトリムする", () => {
		expect(extractBaseName("ふあ  ")).toBe("ふあ");
	});
});

// ─── formatMoodNickname ────────────────────────────────────────────

describe("formatMoodNickname", () => {
	test("neutral の場合はベース名のみ返す", () => {
		expect(formatMoodNickname("neutral", "ふあ")).toBe("ふあ");
	});

	test("happy の場合は @happy 付きで返す", () => {
		expect(formatMoodNickname("happy", "ふあ")).toBe("ふあ @happy");
	});

	test("sad の場合は @sad 付きで返す", () => {
		expect(formatMoodNickname("sad", "ふあ")).toBe("ふあ @sad");
	});

	test("surprised の場合は @surprised 付きで返す", () => {
		expect(formatMoodNickname("surprised", "Test Bot")).toBe("Test Bot @surprised");
	});
});

// ─── MoodNicknameService.update() ─────────────────────────────────

describe("MoodNicknameService.update()", () => {
	test("各ギルドの mood を読み取り、適切なニックネームを設定する", async () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			"discord:guild-1": createEmotion(0.8, 0.6, 0.3),
		});
		const service = new MoodNicknameService(gateway, moodReader, createMockLogger(), ["guild-1"]);

		await service.update();

		expect(gateway.setGuildNickname).toHaveBeenCalledWith("guild-1", "ふあ @happy");
	});

	test("複数ギルドがそれぞれ独立に更新される", async () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			"discord:guild-1": createEmotion(0.8, 0.6, 0.3),
			"discord:guild-2": createEmotion(-0.6, -0.5, -0.2),
		});
		const service = new MoodNicknameService(gateway, moodReader, createMockLogger(), [
			"guild-1",
			"guild-2",
		]);

		await service.update();

		expect(gateway.setGuildNickname).toHaveBeenCalledTimes(2);
		expect(gateway.setGuildNickname).toHaveBeenCalledWith("guild-1", "ふあ @happy");
		expect(gateway.setGuildNickname).toHaveBeenCalledWith("guild-2", "ふあ @sad");
	});

	test("全て neutral ならベース名のみ設定される", async () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			"discord:guild-1": NEUTRAL_EMOTION,
			"discord:guild-2": NEUTRAL_EMOTION,
		});
		const service = new MoodNicknameService(gateway, moodReader, createMockLogger(), [
			"guild-1",
			"guild-2",
		]);

		await service.update();

		expect(gateway.setGuildNickname).toHaveBeenCalledWith("guild-1", "ふあ");
		expect(gateway.setGuildNickname).toHaveBeenCalledWith("guild-2", "ふあ");
	});

	test("カスタム defaultName を使用する", async () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			"discord:guild-1": createEmotion(0.8, 0.6, 0.3),
		});
		const service = new MoodNicknameService(gateway, moodReader, createMockLogger(), ["guild-1"], {
			defaultName: "テスト",
		});

		await service.update();

		expect(gateway.setGuildNickname).toHaveBeenCalledWith("guild-1", "テスト @happy");
	});

	test("gateway がエラーを投げても例外をスローしない", async () => {
		const gateway = {
			setGuildNickname: mock(() => Promise.reject(new Error("Discord API error"))),
		};
		const moodReader = createMockMoodReader({
			"discord:guild-1": createEmotion(0.8, 0.6, 0.3),
		});
		const logger = createMockLogger();
		const service = new MoodNicknameService(gateway, moodReader, logger, ["guild-1"]);

		await service.update();
		expect(logger.warn).toHaveBeenCalled();
	});
});

// ─── MoodNicknameService.start() / stop() ─────────────────────────

describe("MoodNicknameService lifecycle", () => {
	let service: MoodNicknameService;

	afterEach(() => {
		service?.stop();
	});

	test("start() が即時に1回更新する", async () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			"discord:guild-1": createEmotion(0.5, -0.4, 0.2),
		});
		service = new MoodNicknameService(gateway, moodReader, createMockLogger(), ["guild-1"], {
			intervalMs: 60_000,
		});

		service.start();

		// start() は即時に update() を呼ぶので、少し待ってから確認
		await new Promise((resolve) => {
			setTimeout(resolve, 50);
		});
		expect(gateway.setGuildNickname).toHaveBeenCalledTimes(1);
		expect(gateway.setGuildNickname).toHaveBeenCalledWith("guild-1", "ふあ @relaxed");
	});

	test("stop() 後はタイマーによる更新が止まる", async () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			"discord:guild-1": createEmotion(0.8, 0.6, 0.3),
		});
		service = new MoodNicknameService(gateway, moodReader, createMockLogger(), ["guild-1"], {
			intervalMs: 50,
		});

		service.start();

		// 即時更新を待つ
		await new Promise((resolve) => {
			setTimeout(resolve, 30);
		});
		expect(gateway.setGuildNickname).toHaveBeenCalledTimes(1);

		service.stop();

		// stop 後に intervalMs 以上待っても追加呼び出しがないことを確認
		await new Promise((resolve) => {
			setTimeout(resolve, 120);
		});
		expect(gateway.setGuildNickname).toHaveBeenCalledTimes(1);
	});
});
