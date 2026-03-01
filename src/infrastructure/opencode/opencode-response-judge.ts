import type {
	ConversationContext,
	ConversationMessage,
} from "../../domain/entities/conversation-context.ts";
import type { ResponseAction, ResponseDecision } from "../../domain/entities/response-decision.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";

const JUDGE_SESSION_KEY = "system:judge:_internal";

function formatContext(messages: ConversationMessage[]): string {
	return messages.map((m) => `${m.authorName}: ${m.content}`).join("\n");
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

## 出力形式
以下のJSON形式のみで回答してください。それ以外のテキストは不要です。
{"action":"respond","reason":"..."}
{"action":"react","emoji":"😊","reason":"..."}
{"action":"ignore","reason":"..."}
`;

export class OpencodeResponseJudge implements ResponseJudge {
	constructor(
		private readonly agent: AiAgent,
		private readonly logger: Logger,
	) {}

	async judge(message: string, context: ConversationContext): Promise<ResponseDecision> {
		const contextStr = formatContext(context.messages);
		const prompt = `${JUDGE_PROMPT}\n\n## 直近の会話\n${contextStr}\n\n## 最新メッセージ\n${message}`;

		try {
			const response = await this.agent.send(JUDGE_SESSION_KEY, prompt);
			return this.parseResponse(response.text);
		} catch (error) {
			this.logger.error("Judge AI call failed:", error);
			return { action: { type: "ignore" }, reason: "judge error" };
		}
	}

	private parseResponse(text: string): ResponseDecision {
		try {
			// Extract JSON from response (may contain extra text)
			const jsonMatch = text.match(/\{[^}]+\}/);
			if (!jsonMatch) throw new Error("No JSON found in response");

			const parsed = JSON.parse(jsonMatch[0]) as {
				action: string;
				emoji?: string;
				reason?: string;
			};

			const action = this.parseAction(parsed.action, parsed.emoji);
			return { action, reason: parsed.reason ?? "" };
		} catch (error) {
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
