import { opencodeAgent } from "./opencode.ts";
import { copilotAgent } from "./copilot.ts";

export interface AgentResponse {
  text: string;
  sessionId: string;
}

export interface AgentBackend {
  name: string;
  send(sessionId: string, message: string): Promise<AgentResponse>;
  stop(): Promise<void>;
}

const agents: Record<string, AgentBackend> = {
  opencode: opencodeAgent,
  copilot: copilotAgent,
};

// ギルドごとのアクティブ agent 設定
const guildAgent = new Map<string, string>();
const DEFAULT_AGENT = "opencode";

export function getAgent(guildId?: string): AgentBackend {
  const name = (guildId && guildAgent.get(guildId)) ?? DEFAULT_AGENT;
  return agents[name] ?? agents[DEFAULT_AGENT]!;
}

export function setAgent(guildId: string, agentName: string): boolean {
  if (!(agentName in agents)) return false;
  guildAgent.set(guildId, agentName);
  return true;
}

export function listAgentNames(): string[] {
  return Object.keys(agents);
}

/**
 * セッションキー導出 (OpenClaw 参考)
 * チャンネル + ユーザー → 決定的セッション ID
 */
export function deriveSessionKey(channelId: string, userId: string): string {
  return `discord:${channelId}:${userId}`;
}
