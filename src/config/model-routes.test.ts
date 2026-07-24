import { expect, test } from "vitest";
import { loadModelRoutes, type ModelTarget } from "./model-routes.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test("loads and hashes model routes", async () => {
  const target: ModelTarget = { provider: "openai", model: "gpt-5-mini", thinkingLevel: "minimal", timeoutMs: 20000 };
  const dir = await mkdtemp(join(tmpdir(), "routes-"));
  const file = join(dir, "routes.json");
  const raw = JSON.stringify({
    schemaVersion: 1,
    routes: {
      mention_response: {
        deadlineMs: 25000,
        targets: [target],
      },
    },
  });
  await writeFile(file, raw);
  try {
    const a = await loadModelRoutes(file);
    const b = await loadModelRoutes(file);
    expect(a).toEqual(b);
    expect(a.version).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(a.mentionResponseDeadlineMs).toBe(25000);
    expect(a.mentionResponse).toEqual([
      { provider: "openai", model: "gpt-5-mini", thinkingLevel: "minimal", timeoutMs: 20000 },
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("rejects invalid routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "routes-"));
  const file = join(dir, "bad.json");
  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 1, routes: { mention_response: { deadlineMs: 1, targets: [] } } }),
  );
  await expect(loadModelRoutes(file)).rejects.toThrow();
  await rm(dir, { recursive: true });
});

test("rejects unknown keys at every route level", async () => {
  const dir = await mkdtemp(join(tmpdir(), "routes-"));
  const file = join(dir, "unknown.json");
  const base = {
    schemaVersion: 1,
    routes: {
      mention_response: {
        deadlineMs: 25000,
        targets: [{ provider: "p", model: "m", thinkingLevel: "off", timeoutMs: 1000 }],
      },
    },
  };
  for (const value of [
    { ...base, typo: true },
    { ...base, routes: { ...base.routes, typo: true } },
    { ...base, routes: { mention_response: { ...base.routes.mention_response, typo: true } } },
    {
      ...base,
      routes: {
        mention_response: {
          ...base.routes.mention_response,
          targets: [{ ...base.routes.mention_response.targets[0], typo: true }],
        },
      },
    },
  ]) {
    await writeFile(file, JSON.stringify(value));
    await expect(loadModelRoutes(file)).rejects.toThrow();
  }
  await rm(dir, { recursive: true });
});
