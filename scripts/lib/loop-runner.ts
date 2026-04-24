/**
 * loop-runner.ts — ループラッパースクリプト共通ユーティリティ。
 *
 * auto-triage.ts / character-audit.ts 等で共有される関数群。
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

export function extractAssistantText(line: string): string[] {
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
