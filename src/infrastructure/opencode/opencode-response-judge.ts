import type { Attachment } from "../../domain/entities/attachment.ts";
import type {
	ConversationContext,
	ConversationMessage,
} from "../../domain/entities/conversation-context.ts";
import type { EmojiInfo } from "../../domain/entities/emoji-info.ts";
import type { ResponseAction, ResponseDecision } from "../../domain/entities/response-decision.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import { formatTime } from "../../domain/services/format-timestamp.ts";

const JUDGE_SESSION_KEY = "system:judge:_internal";

function formatContext(messages: ConversationMessage[]): string {
	return messages
		.map((m) => `[${formatTime(m.timestamp)}] ${m.authorName}: ${m.content}`)
		.join("\n");
}

const JUDGE_PROMPT = `あなたはDiscordサーバーに住んでいる「ふあ」です。
以下の会話の流れと最新メッセージを見て、あなたが参加すべきかどうかを判断してください。

## 判断基準
- 自分の名前(ふあ)が含まれている → respond
- 自分に話しかけている雰囲気がある → respond
- 自分が詳しい話題で有益な情報を提供できる → respond
- 面白い・共感できる話題で一言添えたい → react
- 自分に関係ない会話、プライベートな話題 → ignore
- 判断に迷ったら → ignore
- [Bot] プレフィックスがある場合、送信者はBotです。Botからのメッセージには基本的にignore寄りで判断し、明確に自分に話しかけている場合のみrespond

## 出力形式
以下のJSON形式のみで回答してください。それ以外のテキストは不要です。
{"action":"respond","reason":"..."}
{"action":"react","emoji":"😊","reason":"..."}
{"action":"ignore","reason":"..."}

emoji にはUnicode絵文字か、カスタム絵文字の場合は :name: 形式（例: :pepe_sad:）を指定してください。
`;

export class OpencodeResponseJudge implements ResponseJudge {
	constructor(
		private readonly agent: AiAgent,
		private readonly logger: Logger,
	) {}

	async judge(
		message: string,
		context: ConversationContext,
		availableEmojis?: EmojiInfo[],
		attachments?: Attachment[],
	): Promise<ResponseDecision> {
		const contextStr = formatContext(context.messages);
		const emojiSection =
			availableEmojis && availableEmojis.length > 0
				? `\n\n## 利用可能なカスタム絵文字\n以下のカスタム絵文字も使えます（:name: 形式で指定）:\n${availableEmojis.map((e) => `:${e.name}:`).join(" ")}`
				: "";
		const attachmentSection =
			attachments && attachments.length > 0
				? `\n（画像が${attachments.length}枚添付されています）`
				: "";
		const prompt = `${JUDGE_PROMPT}${emojiSection}\n\n## 直近の会話\n${contextStr}\n\n## 最新メッセージ\n${message}${attachmentSection}`;

		try {
			const response = await this.agent.send({ sessionKey: JUDGE_SESSION_KEY, message: prompt });
			return this.parseResponse(response.text);
		} catch (error) {
			this.logger.error("Judge AI call failed:", error);
			return { action: { type: "ignore" }, reason: "judge error" };
		}
	}

	private parseResponse(text: string): ResponseDecision {
		try {
			const firstBrace = text.indexOf("{");
			const lastBrace = text.lastIndexOf("}");
			if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
				throw new Error("No JSON found in response");
			}

			const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1)) as {
				action: string;
				emoji?: string;
				reason?: string;
			};

			const action = this.parseAction(parsed.action, parsed.emoji);
			return { action, reason: parsed.reason ?? "" };
		} catch {
			this.logger.warn("Failed to parse judge response, defaulting to ignore:", text);
			return { action: { type: "ignore" }, reason: "parse error" };
		}
	}

	private parseAction(action: string, emoji?: string): ResponseAction {
		switch (action) {
			case "respond":
				return { type: "respond" };
			case "react":
				return { type: "react", emoji: emoji ?? "👀" };
			case "ignore":
				return { type: "ignore" };
			default:
				return { type: "ignore" };
		}
	}
}
