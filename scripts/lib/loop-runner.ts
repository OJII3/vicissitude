/**
 * loop-runner.ts — ループラッパースクリプト共通ユーティリティ。
 *
 * auto-triage-*.ts で共有される関数群。
 */
import { appendFileSync } from "node:fs";

export const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatTimestamp(): string {
	const now = new Date();
	return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

export function tee(msg: string, logFile: string): void {
	console.log(msg);
	appendFileSync(logFile, `${msg}\n`);
}

export function extractClaudeAssistantText(line: string): string[] {
	try {
		const obj = JSON.parse(line);
		if (obj.type !== "assistant") return [];
		const contents: unknown[] = obj.message?.content ?? [];
		return contents
			.filter(
				(c): c is { type: "text"; text: string } =>
					(c as { type: string }).type === "text" &&
					typeof (c as { text: unknown }).text === "string",
			)
			.map((c) => c.text);
	} catch {
		return [];
	}
}

export function extractCodexAssistantText(line: string): string[] {
	try {
		const obj = JSON.parse(line) as Record<string, unknown>;
		if (typeof obj.message === "string") return [obj.message];
		if (typeof obj.text === "string") return [obj.text];
		if (typeof obj.content === "string") return [obj.content];

		const item = obj.item as { type?: string; text?: string } | undefined;
		if (item?.type === "message" && typeof item.text === "string") return [item.text];

		return [];
	} catch {
		return [];
	}
}
