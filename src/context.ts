import { resolve } from "path";
import { existsSync } from "fs";

const CONTEXT_DIR = resolve(import.meta.dirname, "../context");

/**
 * OpenClaw 式ブートストラップコンテキスト注入。
 * 各ファイルを <ファイル名> タグで囲んで連結する。
 * ファイルごと最大 20,000 chars、合計 150,000 chars まで。
 */

const BOOTSTRAP_FILES = [
  "IDENTITY.md",
  "SOUL.md",
  "AGENTS.md",
  "TOOLS.md",
  "USER.md",
  "MEMORY.md",
] as const;

const PER_FILE_MAX = 20_000;
const TOTAL_MAX = 150_000;

async function readContextFile(filename: string): Promise<string | null> {
  const filepath = resolve(CONTEXT_DIR, filename);
  if (!existsSync(filepath)) return null;

  const content = await Bun.file(filepath).text();
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (trimmed.length > PER_FILE_MAX) {
    return trimmed.slice(0, PER_FILE_MAX) + "\n\n[...truncated]";
  }
  return trimmed;
}

/**
 * 全ブートストラップファイルを読み込み、system prompt 用テキストを生成。
 * 毎ターン注入する想定 (OpenClaw と同じ)。
 */
export async function loadBootstrapContext(): Promise<string> {
  const sections: string[] = [];
  let totalLength = 0;

  for (const filename of BOOTSTRAP_FILES) {
    const content = await readContextFile(filename);
    if (!content) continue;

    const section = `<${filename}>\n${content}\n</${filename}>`;
    if (totalLength + section.length > TOTAL_MAX) break;

    sections.push(section);
    totalLength += section.length;
  }

  // 今日の daily log があれば追加
  const today = new Date().toISOString().slice(0, 10);
  const dailyLog = await readContextFile(`memory/${today}.md`);
  if (dailyLog) {
    const section = `<daily-log date="${today}">\n${dailyLog}\n</daily-log>`;
    if (totalLength + section.length <= TOTAL_MAX) {
      sections.push(section);
    }
  }

  return sections.join("\n\n");
}

/**
 * ユーザーメッセージにブートストラップコンテキストを付与。
 */
export async function wrapWithContext(message: string): Promise<string> {
  const ctx = await loadBootstrapContext();
  if (!ctx) return message;

  return `## Project Context\n\n${ctx}\n\n---\n\n${message}`;
}
