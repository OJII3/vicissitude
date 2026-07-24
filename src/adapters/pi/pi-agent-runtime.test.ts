import { expect, test } from "vitest";
import { PiAgentRuntime } from "./pi-agent-runtime.js";
import { AgentRunError } from "../../modules/models/agent-runtime.js";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

test("exposes only faux text and usage", async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux" }] });
  const usage = {
    input: 5,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message = Object.assign(fauxAssistantMessage([fauxThinking("hidden"), fauxText("hello")]), {
    provider: "faux",
    model: "faux",
    responseModel: "faux-response",
    usage,
  });
  faux.setResponses([message]);
  const models = createModels();
  models.setProvider(faux.provider);
  const result = await new PiAgentRuntime(models).run({
    provider: "faux",
    model: "faux",
    thinkingLevel: "minimal",
    timeoutMs: 5000,
    systemPrompt: "x",
    userPrompt: "hello",
  });
  expect(result.text).toBe("hello");
  expect(result.provider).toBe("faux");
  expect(result.model).toBe("faux");
  expect(result.responseModel).toBe("faux-response");
  expect(result.usage).toEqual(usage);
  expect(JSON.stringify(result)).not.toContain("hidden");
});

test("copies optional pi usage fields when present", async () => {
  const base = createModels();
  const model = fauxProvider({ provider: "faux-usage", models: [{ id: "faux" }] });
  base.setProvider(model.provider);
  const models = Object.create(base) as ReturnType<typeof createModels>;
  models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const message = Object.assign(fauxAssistantMessage([fauxText("hello")]), {
      provider: "faux-usage",
      model: "faux",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cacheWrite1h: 5,
        reasoning: 6,
        totalTokens: 10,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    });
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };
  const result = await new PiAgentRuntime(models).run({
    provider: "faux-usage",
    model: "faux",
    thinkingLevel: "off",
    timeoutMs: 5000,
    systemPrompt: "x",
    userPrompt: "u",
  });
  expect(result.usage).toEqual({
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    cacheWrite1h: 5,
    reasoning: 6,
    totalTokens: 10,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
});

test("aborts a pending faux response through the runtime timeout listener", async () => {
  const faux = fauxProvider({ provider: "faux-timeout", models: [{ id: "faux" }] });
  faux.setResponses([
    async (_context, options) =>
      await new Promise((resolve) =>
        options?.signal?.addEventListener("abort", () =>
          resolve(fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "timed out" })),
        ),
      ),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  await expect(
    new PiAgentRuntime(models).run({
      provider: "faux-timeout",
      model: "faux",
      thinkingLevel: "off",
      timeoutMs: 20,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({ provider: "faux-timeout", model: "faux", stopReason: "aborted" });
});

test("rejects an unknown model with exact error metadata", async () => {
  const models = createModels();
  await expect(
    new PiAgentRuntime(models).run({
      provider: "missing",
      model: "missing",
      thinkingLevel: "off",
      timeoutMs: 5000,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({ provider: "missing", model: "missing", stopReason: "error" });
});

test("rejects untrusted request boundaries before model use", async () => {
  const models = createModels();
  for (const request of [
    { provider: " ", model: "m", thinkingLevel: "off", timeoutMs: 1000, systemPrompt: "s", userPrompt: "u" },
    { provider: "p", model: "m", thinkingLevel: "off", timeoutMs: 30001, systemPrompt: "s", userPrompt: "u" },
    { provider: "p", model: "m", thinkingLevel: "off", timeoutMs: 1000, systemPrompt: " ", userPrompt: "u" },
  ])
    await expect(new PiAgentRuntime(models).run(request as never)).rejects.toMatchObject({
      provider: request.provider,
      model: request.model,
      stopReason: "error",
    });
});

test("classifies non-stop responses and prefers provider error messages", async () => {
  const faux = fauxProvider({ provider: "faux-error", models: [{ id: "faux" }] });
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider boom\nBearer abc.secret\u0000" }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  await expect(
    new PiAgentRuntime(models).run({
      provider: "faux-error",
      model: "faux",
      thinkingLevel: "off",
      timeoutMs: 5000,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({
    message: "Provider returned an unsuccessful response",
    provider: "faux-error",
    model: "faux",
    stopReason: "error",
  });
});

test("never exposes provider error text", async () => {
  for (const errorMessage of [
    "token=tok-secret",
    "api_key: key-secret",
    '{"secret":"json-secret"}',
    "Bearer bearer-secret",
    "raw\u0000provider\u001ftext",
  ]) {
    const provider = `faux-${errorMessage.length}`;
    const faux = fauxProvider({ provider, models: [{ id: "faux" }] });
    const base = createModels();
    base.setProvider(faux.provider);
    const models = Object.create(base) as ReturnType<typeof createModels>;
    models.streamSimple = () => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage([], { stopReason: "error", errorMessage });
      queueMicrotask(() => stream.push({ type: "error", reason: "error", error: message }));
      return stream;
    };
    const error = await new PiAgentRuntime(models)
      .run({
        provider,
        model: "faux",
        thinkingLevel: "off",
        timeoutMs: 5000,
        systemPrompt: "x",
        userPrompt: "u",
      })
      .catch((value: unknown) => value as Error);
    expect(error).toMatchObject({ message: "Provider returned an unsuccessful response", stopReason: "error" });
    expect(JSON.stringify(error)).not.toContain(errorMessage);
  }
});

test("rejects assistant metadata and unsafe usage", async () => {
  const faux = fauxProvider({ provider: "faux-bad", models: [{ id: "faux" }] });
  const base = createModels();
  base.setProvider(faux.provider);
  const models = Object.create(base) as ReturnType<typeof createModels>;
  models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const message = Object.assign(fauxAssistantMessage([fauxText("hello")]), {
      provider: "other",
      model: "faux",
      usage: {
        input: -1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        secret: "token",
      },
    });
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };
  await expect(
    new PiAgentRuntime(models).run({
      provider: "faux-bad",
      model: "faux",
      thinkingLevel: "off",
      timeoutMs: 5000,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({ provider: "faux-bad", model: "faux", stopReason: "error" });
});

test("classifies an aborted assistant message as aborted", async () => {
  const faux = fauxProvider({ provider: "faux-aborted", models: [{ id: "faux" }] });
  faux.setResponses([fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "cancelled" })]);
  const models = createModels();
  models.setProvider(faux.provider);
  await expect(
    new PiAgentRuntime(models).run({
      provider: "faux-aborted",
      model: "faux",
      thinkingLevel: "off",
      timeoutMs: 5000,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({
    message: "Provider returned an unsuccessful response",
    provider: "faux-aborted",
    model: "faux",
    stopReason: "aborted",
  } satisfies Partial<AgentRunError>);
});
