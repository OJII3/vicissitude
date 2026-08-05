/* oxlint-disable typescript/unbound-method */
import { describe, expect, it, vi } from "vitest";
import type { CharacterDefinition } from "../characters/character-definition.js";
import type { JobQueue } from "../jobs/job-queue.js";
import { AgentRunError, type AgentRuntime } from "../models/agent-runtime.js";
import type { Clock } from "../../shared/clock.js";
import {
  handleConversationFailure,
  processConversation,
  type ConversationBatchView,
  type ConversationStore,
} from "./evaluate-conversation.js";

const character: CharacterDefinition = {
  schemaVersion: 1,
  characterId: "primary",
  version: 1,
  name: "テスト",
  language: "ja",
  systemPrompt: "キャラクター",
  failureMessages: ["失敗しました。"],
};
const routes = {
  version: "route-v1",
  mentionResponseDeadlineMs: 25_000,
  mentionResponse: [
    { provider: "first", model: "m1", thinkingLevel: "off" as const, timeoutMs: 5_000 },
    { provider: "second", model: "m2", thinkingLevel: "off" as const, timeoutMs: 5_000 },
  ],
};
const batch: ConversationBatchView = {
  guildId: "g",
  capabilityChannelId: "c",
  targetChannelId: "c",
  threadId: null,
  trigger: {
    eventId: "event-1",
    messageId: "m1",
    actorId: "u",
    occurredAt: new Date("2026-08-04T00:00:00Z"),
    text: "@bot hi",
    mentionedBot: true,
    replyToMessageId: null,
  },
  messages: [
    {
      eventId: "event-1",
      messageId: "m1",
      actorId: "u",
      occurredAt: new Date("2026-08-04T00:00:00Z"),
      text: "@bot hi",
      mentionedBot: true,
      replyToMessageId: null,
    },
    {
      eventId: "event-2",
      messageId: "m2",
      actorId: "u",
      occurredAt: new Date("2026-08-04T00:00:03Z"),
      text: "続き",
      mentionedBot: false,
      replyToMessageId: null,
    },
  ],
};
function store(loaded: ConversationBatchView | null = batch): ConversationStore {
  return {
    loadBatch: vi.fn().mockResolvedValue(loaded),
    startOrLoadRun: vi.fn().mockResolvedValue({ runId: "run-1", state: "running" }),
    recordRunInputEvents: vi.fn(),
    recordModelCall: vi.fn(),
    completeWithReply: vi.fn(),
    succeedWithoutRun: vi.fn(),
    failRunAndJob: vi.fn(),
  };
}
const job = {
  id: "job-1",
  guildId: "g",
  channelId: "c",
  threadId: null,
  triggerEventId: "event-1",
  attempts: 1,
  maxAttempts: 3,
  leaseToken: "token",
};
const claimedAt = new Date("2026-08-04T00:00:08Z");
class MutableClock implements Clock {
  constructor(private current = new Date("2026-08-04T00:00:08.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
function reply(text: string, provider = "first", model = "m1") {
  return { text, provider, model, responseModel: null, usage: null, stopReason: "stop" };
}

describe("processConversation", () => {
  it("records the batch as run input and advances the cursor to the last message", async () => {
    const persistence = store();
    const runtime: AgentRuntime = { run: vi.fn().mockResolvedValue(reply("なるほど")) };
    await processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.recordRunInputEvents)).toHaveBeenCalledWith("run-1", ["event-1", "event-2"]);
    expect(vi.mocked(persistence.completeWithReply)).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerEventId: "event-1",
        cursor: { lastEventId: "event-2", lastOccurredAt: new Date("2026-08-04T00:00:03Z") },
        content: "なるほど",
        fallback: false,
      }),
    );
    const request = vi.mocked(runtime.run).mock.calls[0]![0];
    expect(request.userPrompt).toContain('"triggerMessageId":"m1"');
    expect(request.userPrompt).toContain("@bot hi");
    expect(request.userPrompt).toContain("続き");
  });

  it("succeeds without a run when the batch is empty", async () => {
    const persistence = store(null);
    const runtime: AgentRuntime = { run: vi.fn() };
    await processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.succeedWithoutRun)).toHaveBeenCalledWith(
      "job-1",
      "token",
      "empty_batch",
      expect.any(Date),
    );
    expect(vi.mocked(persistence.startOrLoadRun)).not.toHaveBeenCalled();
    expect(vi.mocked(runtime.run)).not.toHaveBeenCalled();
  });

  it("rejects a job without a trigger event", async () => {
    const persistence = store();
    const runtime: AgentRuntime = { run: vi.fn() };
    await expect(
      processConversation(
        { ...job, triggerEventId: null },
        claimedAt,
        character,
        routes,
        runtime,
        persistence,
        new MutableClock(),
      ),
    ).rejects.toThrow(/trigger event/u);
    expect(vi.mocked(persistence.loadBatch)).not.toHaveBeenCalled();
  });

  it("throws when the decision run is already terminal", async () => {
    const persistence = store();
    persistence.startOrLoadRun = vi.fn().mockResolvedValue({ runId: "run-1", state: "failed" });
    const runtime: AgentRuntime = { run: vi.fn() };
    await expect(
      processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock()),
    ).rejects.toThrow(/already terminal/u);
    expect(vi.mocked(runtime.run)).not.toHaveBeenCalled();
  });

  it("returns early for an already succeeded run", async () => {
    const persistence = store();
    persistence.startOrLoadRun = vi.fn().mockResolvedValue({ runId: "run-1", state: "succeeded" });
    const runtime: AgentRuntime = { run: vi.fn() };
    await processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(runtime.run)).not.toHaveBeenCalled();
    expect(vi.mocked(persistence.completeWithReply)).not.toHaveBeenCalled();
  });

  it("falls back to the second route", async () => {
    const runtime: AgentRuntime = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new AgentRunError("down", "first", "m1", "error"))
        .mockResolvedValueOnce({
          text: "  こんにちは  ",
          provider: "second",
          model: "m2",
          responseModel: null,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        }),
    };
    const persistence = store();
    await processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.startOrLoadRun)).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "token", triggerEventId: "event-1" }),
    );
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "conversation_evaluate" }),
    );
    expect(vi.mocked(persistence.completeWithReply)).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "こんにちは",
        fallback: false,
        leaseToken: "token",
        triggerEventId: "event-1",
      }),
    );
  });

  it("records usage on validation failure and uses character fallback", async () => {
    const persistence = store();
    const runtime: AgentRuntime = {
      run: vi.fn().mockResolvedValue({
        text: " ",
        provider: "first",
        model: "m1",
        responseModel: null,
        usage: {
          input: 3,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      }),
    };
    await processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.completeWithReply)).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "失敗しました。",
        fallback: true,
        cursor: { lastEventId: "event-2", lastOccurredAt: new Date("2026-08-04T00:00:03Z") },
      }),
    );
    expect(vi.mocked(runtime.run)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed", usage: expect.objectContaining({ input: 3 }) }),
    );
  });

  it("records every failed route before character fallback", async () => {
    const persistence = store();
    const runtime: AgentRuntime = { run: vi.fn().mockRejectedValue(new AgentRunError("down", "first", "m1", "error")) };
    await processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledWith(expect.objectContaining({ state: "failed" }));
  });

  it("caps timeout and stops calling routes after the deadline", async () => {
    const persistence = store();
    const controllable = new MutableClock();
    const runtime: AgentRuntime = {
      run: vi.fn().mockImplementation(async (request) => {
        controllable.advance(11_000);
        return {
          text: "",
          provider: request.provider,
          model: request.model,
          responseModel: null,
          usage: null,
          stopReason: "stop",
        };
      }),
    };
    await processConversation(
      job,
      claimedAt,
      character,
      {
        version: routes.version,
        mentionResponseDeadlineMs: 10_000,
        mentionResponse: [{ ...routes.mentionResponse[0]!, timeoutMs: 30_000 }, routes.mentionResponse[1]!],
      },
      runtime,
      persistence,
      controllable,
    );
    expect(vi.mocked(runtime.run)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.run).mock.calls[0]![0].timeoutMs).toBe(10_000);
  });

  it("does not route to another model after persistence failure", async () => {
    const persistence = store();
    persistence.recordModelCall = vi.fn().mockRejectedValue(new Error("db down"));
    const runtime: AgentRuntime = { run: vi.fn().mockResolvedValue(reply("返事")) };
    await expect(
      processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock()),
    ).rejects.toThrow("db down");
    expect(vi.mocked(runtime.run)).toHaveBeenCalledTimes(1);
  });

  it("bubbles completion persistence failure without fallback", async () => {
    const persistence = store();
    persistence.completeWithReply = vi.fn().mockRejectedValue(new Error("completion down"));
    const runtime: AgentRuntime = { run: vi.fn().mockResolvedValue(reply("返事")) };
    await expect(
      processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock()),
    ).rejects.toThrow("completion down");
    expect(vi.mocked(runtime.run)).toHaveBeenCalledTimes(1);
  });

  it("records allowlisted error codes instead of runtime secrets", async () => {
    const persistence = store();
    const runtime: AgentRuntime = {
      run: vi.fn().mockRejectedValue(new AgentRunError("token=secret https://db/password", "p", "m", "error")),
    };
    await processConversation(job, claimedAt, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledWith(
      expect.objectContaining({ error: "model_runtime_failed" }),
    );
  });

  it("retries transient conversation failures with the injected clock", async () => {
    const queue: JobQueue = { claim: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
    const persistence = store();
    const retryClock = new MutableClock();
    await handleConversationFailure(job, "x".repeat(3000), queue, persistence, retryClock);
    expect(vi.mocked(queue.fail)).toHaveBeenCalledWith("job-1", "token", expect.any(String), true, retryClock.now());
    expect(vi.mocked(persistence.failRunAndJob)).not.toHaveBeenCalled();
    expect(vi.mocked(queue.fail).mock.calls[0]![2]).toBe("conversation_processing_failed");
  });

  it("atomically terminates the final conversation failure", async () => {
    const queue: JobQueue = { claim: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
    const failureStore = store();
    const finalJob = { ...job, attempts: 3 };
    await handleConversationFailure(finalJob, "provider unavailable", queue, failureStore, new MutableClock());
    expect(vi.mocked(failureStore.failRunAndJob)).toHaveBeenCalledWith(
      "job-1",
      "token",
      "conversation_processing_failed",
      expect.any(Date),
    );
    expect(vi.mocked(queue.fail)).not.toHaveBeenCalled();
  });
});
