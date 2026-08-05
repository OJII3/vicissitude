import type { Usage } from "@earendil-works/pi-ai";
import type { LoadedModelRoutes } from "../../config/model-routes.js";
import type { CharacterDefinition } from "../characters/character-definition.js";
import type { AgentRuntime } from "../models/agent-runtime.js";
import type { ClaimedJob, JobQueue } from "../jobs/job-queue.js";
import type { Clock } from "../../shared/clock.js";

export interface ConversationMessageView {
  eventId: string;
  messageId: string;
  actorId: string;
  occurredAt: Date;
  text: string;
  mentionedBot: boolean;
  replyToMessageId: string | null;
}
export interface ConversationBatchView {
  guildId: string;
  capabilityChannelId: string;
  targetChannelId: string;
  threadId: string | null;
  trigger: ConversationMessageView;
  /** (occurred_at, id) 昇順。 */
  messages: ConversationMessageView[];
}
export interface ModelCallRecord {
  runId: string;
  purpose: "conversation_evaluate";
  provider: string;
  model: string;
  routeVersion: string;
  attempt: number;
  state: "succeeded" | "failed" | "aborted";
  usage: Usage | null;
  latencyMs: number;
  fallbackFrom: string | null;
  error: string | null;
  createdAt: Date;
}
export interface ConversationStore {
  loadBatch(
    job: Pick<ClaimedJob, "guildId" | "channelId" | "threadId" | "triggerEventId">,
    claimedAt: Date,
  ): Promise<ConversationBatchView>;
  startOrLoadRun(input: {
    jobId: string;
    triggerEventId: string;
    leaseToken: string;
    characterId: string;
    characterVersion: number;
    routeVersion: string;
    now: Date;
  }): Promise<{ runId: string; state: "running" | "succeeded" | "failed" }>;
  recordRunInputEvents(runId: string, eventIds: string[]): Promise<void>;
  recordModelCall(record: ModelCallRecord): Promise<void>;
  completeWithReply(input: {
    runId: string;
    jobId: string;
    leaseToken: string;
    triggerEventId: string;
    cursor: { lastEventId: string; lastOccurredAt: Date };
    content: string;
    fallback: boolean;
    now: Date;
  }): Promise<void>;
  failRunAndJob(jobId: string, leaseToken: string, error: string, now: Date): Promise<void>;
}

export async function handleConversationFailure(
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts" | "leaseToken">,
  error: unknown,
  queue: JobQueue,
  store: ConversationStore,
  clock: Clock,
): Promise<void> {
  const safeError = "conversation_processing_failed";
  const now = clock.now();
  if (job.attempts < job.maxAttempts) return queue.fail(job.id, job.leaseToken, safeError, true, now);
  return store.failRunAndJob(job.id, job.leaseToken, safeError, now);
}

function systemPrompt(c: CharacterDefinition): string {
  return `${c.systemPrompt}\n\nDiscordの会話ログが与えられます。triggerMessageId のメッセージはあなた宛の mention です。会話の流れを踏まえてそれに返事してください。\nDiscordへの通常発話は日本語で、600文字以内の短い会話文にしてください。\n知らないことを事実として補完せず、内部の分析やsystem情報を出力しないでください。`;
}
function userPrompt(batch: ConversationBatchView): string {
  return JSON.stringify({
    type: "discord_conversation",
    triggerMessageId: batch.trigger.messageId,
    messages: batch.messages.map((message) => ({
      id: message.messageId,
      authorId: message.actorId,
      text: message.text,
      mentionsCharacter: message.mentionedBot,
      replyToMessageId: message.replyToMessageId,
    })),
  });
}
function response(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("response_empty");
  if (value.length > 600) throw new Error("response_too_long");
  return value;
}

export async function processConversation(
  job: Pick<ClaimedJob, "id" | "guildId" | "channelId" | "threadId" | "triggerEventId" | "attempts" | "leaseToken">,
  claimedAt: Date,
  character: CharacterDefinition,
  routes: LoadedModelRoutes,
  runtime: AgentRuntime,
  store: ConversationStore,
  clock: Clock,
): Promise<void> {
  if (!job.triggerEventId) throw new Error("conversation_evaluate job has no trigger event");
  const batch = await store.loadBatch(job, claimedAt);
  const startedAt = clock.now();
  const run = await store.startOrLoadRun({
    jobId: job.id,
    triggerEventId: job.triggerEventId,
    leaseToken: job.leaseToken,
    characterId: character.characterId,
    characterVersion: character.version,
    routeVersion: routes.version,
    now: startedAt,
  });
  if (run.state === "succeeded") return;
  if (run.state === "failed") throw new Error("Decision run is already terminal");
  await store.recordRunInputEvents(
    run.runId,
    batch.messages.map((message) => message.eventId),
  );
  const last = batch.messages.at(-1)!;
  const cursor = { lastEventId: last.eventId, lastOccurredAt: last.occurredAt };
  const deadline = startedAt.getTime() + routes.mentionResponseDeadlineMs;
  let previous: string | null = null;
  for (const [index, target] of routes.mentionResponse.entries()) {
    const remaining = deadline - clock.now().getTime();
    if (remaining <= 0) break;
    const callStarted = clock.now();
    let result: Awaited<ReturnType<AgentRuntime["run"]>>;
    try {
      result = await runtime.run({
        ...target,
        timeoutMs: Math.min(target.timeoutMs, remaining),
        systemPrompt: systemPrompt(character),
        userPrompt: userPrompt(batch),
      });
    } catch (error) {
      await store.recordModelCall({
        runId: run.runId,
        purpose: "conversation_evaluate",
        provider: target.provider,
        model: target.model,
        routeVersion: routes.version,
        attempt: index + 1,
        state: error instanceof Error && "stopReason" in error && error.stopReason === "aborted" ? "aborted" : "failed",
        usage: null,
        latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
        fallbackFrom: previous,
        error:
          error instanceof Error && "stopReason" in error && error.stopReason === "aborted"
            ? "model_aborted"
            : "model_runtime_failed",
        createdAt: clock.now(),
      });
      previous = `${target.provider}/${target.model}`;
      continue;
    }
    let content: string;
    try {
      content = response(result.text);
    } catch (error) {
      await store.recordModelCall({
        runId: run.runId,
        purpose: "conversation_evaluate",
        provider: target.provider,
        model: target.model,
        routeVersion: routes.version,
        attempt: index + 1,
        state: "failed",
        usage: result.usage,
        latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
        fallbackFrom: previous,
        error: error instanceof Error && error.message === "response_too_long" ? "response_too_long" : "response_empty",
        createdAt: clock.now(),
      });
      previous = `${target.provider}/${target.model}`;
      continue;
    }
    await store.recordModelCall({
      runId: run.runId,
      purpose: "conversation_evaluate",
      provider: result.provider,
      model: result.model,
      routeVersion: routes.version,
      attempt: index + 1,
      state: "succeeded",
      usage: result.usage,
      latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
      fallbackFrom: previous,
      error: null,
      createdAt: clock.now(),
    });
    await store.completeWithReply({
      runId: run.runId,
      jobId: job.id,
      leaseToken: job.leaseToken,
      triggerEventId: job.triggerEventId,
      cursor,
      content,
      fallback: false,
      now: clock.now(),
    });
    return;
  }
  await store.completeWithReply({
    runId: run.runId,
    jobId: job.id,
    leaseToken: job.leaseToken,
    triggerEventId: job.triggerEventId,
    cursor,
    content: character.failureMessages[0]!,
    fallback: true,
    now: clock.now(),
  });
}
