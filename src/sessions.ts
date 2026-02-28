import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";

const DATA_DIR = resolve(import.meta.dirname, "../data");
const SESSIONS_FILE = resolve(DATA_DIR, "sessions.json");

/**
 * セッションキー → agent 側の実セッション ID マッピング。
 * ディスクに永続化して再起動後も同じセッションを使い回す。
 *
 * キー形式: "{agentName}:{sessionKey}"
 * 例: "copilot:discord:123456:789012"
 */
type SessionMap = Record<string, string>;

let cache: SessionMap | null = null;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load(): SessionMap {
  ensureDataDir();
  if (!existsSync(SESSIONS_FILE)) return {};
  try {
    const text = Bun.file(SESSIONS_FILE).text();
    // Bun.file().text() returns a Promise, but we need sync for init
    // Use require for sync read instead
    const raw = require("fs").readFileSync(SESSIONS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getMap(): SessionMap {
  if (!cache) cache = load();
  return cache;
}

async function save() {
  ensureDataDir();
  await Bun.write(SESSIONS_FILE, JSON.stringify(getMap(), null, 2));
}

function makeKey(agentName: string, sessionKey: string): string {
  return `${agentName}:${sessionKey}`;
}

export function getSessionId(
  agentName: string,
  sessionKey: string,
): string | undefined {
  return getMap()[makeKey(agentName, sessionKey)];
}

export async function setSessionId(
  agentName: string,
  sessionKey: string,
  realSessionId: string,
) {
  getMap()[makeKey(agentName, sessionKey)] = realSessionId;
  await save();
}

/**
 * セッションが新規かどうかを判定。
 * 新規ならコンテキスト注入が必要。
 */
export function isNewSession(
  agentName: string,
  sessionKey: string,
): boolean {
  return getSessionId(agentName, sessionKey) === undefined;
}
