import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
export type { Usage } from "@earendil-works/pi-ai";
export interface AgentRunRequest {
  provider: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
  timeoutMs: number;
  systemPrompt: string;
  userPrompt: string;
}
export interface AgentRunResult {
  text: string;
  provider: string;
  model: string;
  responseModel: string | null;
  usage: Usage;
  stopReason: "stop";
}
export class AgentRunError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly model: string,
    public readonly stopReason: "error" | "aborted",
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}
export interface AgentRuntime {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
