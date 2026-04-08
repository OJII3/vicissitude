/* oxlint-disable no-non-null-assertion -- test assertions after length/null checks */
import { describe, expect, test } from "bun:test";

import {
	captureTools,
	createClientStubWithImageAttachments,
	createClientStubWithMultipleImageAttachments,
	createClientStubWithReactError,
	createDiscordClientStub,
	type ToolResult,
} from "./discord-test-helpers";

// ─── Tests ───────────────────────────────────────────────────────

describe("registerDiscordTools", () => {
	test("5つのツールが登録される", () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });

		const expectedTools = [
			"send_message",
			"reply",
			"add_reaction",
			"read_messages",
			"list_channels",
		];
		for (const name of expectedTools) {
			expect(tools.has(name)).toBe(true);
		}
		expect(tools.size).toBe(5);
		expect(tools.has("send_typing")).toBe(false);
	});

	test("戻り値はクリーンアップ関数である", () => {
		const { cleanup } = captureTools({ discordClient: createDiscordClientStub() });

		expect(typeof cleanup).toBe("function");
	});
});

describe("send_message", () => {
	test("メッセージ送信成功時にメッセージID付きレスポンスを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const sendMessage = tools.get("send_message")!;

		const result = (await sendMessage({
			channel_id: "ch-1",
			content: "テスト",
		})) as ToolResult;

		expect(result.content[0]!.text).toBe("Sent message sent-msg-1");
	});

	test("送信時に typing が表示される", async () => {
		const client = createDiscordClientStub();
		const { tools } = captureTools({ discordClient: client });
		const sendMessage = tools.get("send_message")!;

		await sendMessage({ channel_id: "ch-1", content: "テスト" });

		expect(client._sendTypingMock).toHaveBeenCalled();
	});

	test("不正な file_path でエラーになる", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const sendMessage = tools.get("send_message")!;

		let threw = false;
		try {
			await sendMessage({
				channel_id: "ch-1",
				content: "テスト",
				file_path: "/nonexistent/path/file.png",
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

describe("reply", () => {
	test("リプライ送信成功時にメッセージID付きレスポンスを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const reply = tools.get("reply")!;

		const result = (await reply({
			channel_id: "ch-1",
			message_id: "msg-1",
			content: "返信テスト",
		})) as ToolResult;

		expect(result.content[0]!.text).toBe("Replied with message reply-msg-1");
	});

	test("リプライ送信時に typing が表示される", async () => {
		const client = createDiscordClientStub();
		const { tools } = captureTools({ discordClient: client });
		const reply = tools.get("reply")!;

		await reply({ channel_id: "ch-1", message_id: "msg-1", content: "返信テスト" });

		expect(client._sendTypingMock).toHaveBeenCalled();
	});

	test("不正な file_path でエラーになる", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const reply = tools.get("reply")!;

		let threw = false;
		try {
			await reply({
				channel_id: "ch-1",
				message_id: "msg-1",
				content: "テスト",
				file_path: "/nonexistent/path/file.png",
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

describe("add_reaction", () => {
	test("リアクション追加成功時に絵文字付きレスポンスを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const addReaction = tools.get("add_reaction")!;

		const result = (await addReaction({
			channel_id: "ch-1",
			message_id: "msg-1",
			emoji: "👍",
		})) as ToolResult;

		expect(result.content[0]!.text).toBe("Reacted with 👍");
	});

	test("react() が失敗した場合は例外がそのまま throw される", () => {
		const { tools } = captureTools({ discordClient: createClientStubWithReactError() });
		const addReaction = tools.get("add_reaction")!;

		expect(
			addReaction({ channel_id: "ch-1", message_id: "msg-1", emoji: "invalid" }),
		).rejects.toThrow("Unknown Emoji");
	});
});

describe("read_messages", () => {
	test("メッセージを [author.tag] content 形式でフォーマットする", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const readMessages = tools.get("read_messages")!;

		const result = (await readMessages({
			channel_id: "ch-1",
			limit: 10,
		})) as ToolResult;

		expect(result.content[0]!.text).toContain("[user#1234] hello world");
	});

	test("画像添付がある場合は [images: url] を表示する", async () => {
		const { tools } = captureTools({
			discordClient: createClientStubWithImageAttachments(),
		});
		const readMessages = tools.get("read_messages")!;

		const result = (await readMessages({
			channel_id: "ch-1",
			limit: 10,
		})) as ToolResult;

		expect(result.content[0]!.text).toContain("[user#5678] 写真だよ");
		expect(result.content[0]!.text).toContain("[images: https://cdn.example.com/img.png]");
	});

	test("複数画像添付がある場合はカンマ区切りでまとめて表示する", async () => {
		const { tools } = captureTools({
			discordClient: createClientStubWithMultipleImageAttachments(),
		});
		const readMessages = tools.get("read_messages")!;

		const result = (await readMessages({
			channel_id: "ch-1",
			limit: 10,
		})) as ToolResult;

		expect(result.content[0]!.text).toContain("[user#9999] 複数画像だよ");
		expect(result.content[0]!.text).toContain(
			"[images: https://cdn.example.com/img1.png, https://cdn.example.com/img2.jpg]",
		);
	});
});

describe("list_channels", () => {
	test("テキストチャンネル一覧を name (id) 形式で返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const listChannels = tools.get("list_channels")!;

		const result = (await listChannels({ guild_id: "guild-1" })) as ToolResult;

		expect(result.content[0]!.text).toContain("general (ch-1)");
		expect(result.content[0]!.text).toContain("random (ch-2)");
		// voice チャンネルは含まれない
		expect(result.content[0]!.text).not.toContain("voice");
	});

	test("boundGuildId 使用時は guild_id を省略できる", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() }, "bound-guild-1");
		const listChannels = tools.get("list_channels")!;

		const result = (await listChannels({})) as ToolResult;

		expect(result.content[0]!.text).toContain("general (ch-1)");
	});

	test("boundGuildId なしで guild_id 未指定時はエラーメッセージを返す", async () => {
		const { tools } = captureTools({ discordClient: createDiscordClientStub() });
		const listChannels = tools.get("list_channels")!;

		const result = (await listChannels({})) as ToolResult;

		expect(result.content[0]!.text).toContain("guild_id");
	});
});
