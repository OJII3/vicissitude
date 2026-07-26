import { Agent } from "@earendil-works/pi-agent-core";
import type { Model, Models, Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  AgentRunError,
  type AgentRuntime,
  type AgentRunRequest,
  type AgentRunResult,
} from "../../modules/models/agent-runtime.js";

const RequestSchema = z.strictObject({
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(300),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  timeoutMs: z.number().int().finite().positive().max(30000),
  systemPrompt: z.string().trim().min(1).max(20000),
  userPrompt: z.string().trim().min(1).max(20000),
});
const UsageSchema = z.strictObject({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(),
  cacheWrite: z.number().finite().nonnegative(),
  cacheWrite1h: z.number().finite().nonnegative().optional(),
  reasoning: z.number().finite().nonnegative().optional(),
  totalTokens: z.number().finite().nonnegative(),
  cost: z.strictObject({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(),
    cacheWrite: z.number().finite().nonnegative(),
    total: z.number().finite().nonnegative(),
  }),
});
function safeErrorMessage(value: unknown): string {
  return String(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\b(bearer|token|secret|api[_ -]?key)\s+[A-Za-z0-9._~+\-/]+=*/giu, "$1 [REDACTED]")
    .slice(0, 1000);
}

export class PiAgentRuntime implements AgentRuntime {
  public constructor(private readonly models: Models) {}
  public async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const provider = typeof request?.provider === "string" ? request.provider : "";
    const modelName = typeof request?.model === "string" ? request.model : "";
    let signal: AbortSignal | undefined;
    let abort: (() => void) | undefined;
    try {
      const parsed = RequestSchema.parse(request);
      const model = this.models.getModel(parsed.provider, parsed.model) as Model<any> | undefined;
      if (!model)
        throw new AgentRunError(
          `Model not found: ${parsed.provider}/${parsed.model}`,
          parsed.provider,
          parsed.model,
          "error",
        );
      signal = AbortSignal.timeout(parsed.timeoutMs);
      const agent = new Agent({
        streamFn: this.models.streamSimple.bind(this.models),
        maxRetryDelayMs: parsed.timeoutMs,
        initialState: {
          systemPrompt: parsed.systemPrompt,
          model,
          thinkingLevel: parsed.thinkingLevel,
          tools: [],
          messages: [],
        } as any,
      });
      abort = () => agent.abort();
      signal.addEventListener("abort", abort);
      await agent.prompt(parsed.userPrompt);
      const message = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant") as any;
      if (!message || message.stopReason !== "stop") {
        const stopReason = message?.stopReason === "aborted" ? "aborted" : "error";
        throw new AgentRunError(
          message?.errorMessage === undefined
            ? "Agent did not stop normally"
            : "Provider returned an unsuccessful response",
          parsed.provider,
          parsed.model,
          stopReason,
        );
      }
      const text = (message.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("")
        .trim();
      if (!text) throw new AgentRunError("Agent returned no text", parsed.provider, parsed.model, "error");
      const usage = UsageSchema.parse(message.usage);
      if (message.provider !== parsed.provider || message.model !== parsed.model)
        throw new AgentRunError("Assistant metadata mismatch", parsed.provider, parsed.model, "error");
      if (
        message.responseModel !== undefined &&
        message.responseModel !== null &&
        typeof message.responseModel !== "string"
      )
        throw new AgentRunError("Invalid response model", parsed.provider, parsed.model, "error");
      const resultUsage: Usage = {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        cost: usage.cost,
      };
      if (usage.cacheWrite1h !== undefined) resultUsage.cacheWrite1h = usage.cacheWrite1h;
      if (usage.reasoning !== undefined) resultUsage.reasoning = usage.reasoning;
      return {
        text,
        provider: message.provider,
        model: message.model,
        responseModel: message.responseModel ?? null,
        usage: structuredClone(resultUsage),
        stopReason: "stop",
      };
    } catch (error) {
      if (error instanceof AgentRunError)
        throw new AgentRunError(safeErrorMessage(error.message), error.provider, error.model, error.stopReason);
      throw new AgentRunError(
        safeErrorMessage(error instanceof Error ? error.message : error),
        provider,
        modelName,
        signal?.aborted ? "aborted" : "error",
      );
    } finally {
      if (signal && abort) signal.removeEventListener("abort", abort);
    }
  }
}
