import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conversationScenarioSchema, loadScenarios } from "./scenario.js";

const message1 = {
  kind: "message",
  atMs: 0,
  id: "m1",
  channelId: "channel-1",
  threadId: null,
  actorId: "user-a",
  content: "@ふあ こんにちは",
  mentionsBot: true,
};

const baseLabel = {
  addressee: { kind: "character" },
  expectedAction: "reply",
  referencedMessageIds: ["m1"],
  maxWaitMs: 15000,
  misinterventionSeverity: "low",
};

const base = {
  name: "fixture",
  description: "スキーマ検証用のフィクスチャ",
  guildId: "guild-1",
  events: [message1],
  label: baseLabel,
};

describe("conversationScenarioSchema", () => {
  it("accepts a valid scenario and fills defaults", () => {
    const result = conversationScenarioSchema.parse(base);
    expect(result.events[0]).toMatchObject({ kind: "message", replyToId: null });
  });

  it("accepts a silence scenario without maxWaitMs", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      events: [{ ...message1, content: "腹減った", mentionsBot: false }],
      label: {
        addressee: { kind: "channel" },
        expectedAction: "silence",
        referencedMessageIds: [],
        maxWaitMs: null,
        misinterventionSeverity: "medium",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects events that are not ordered by atMs", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      events: [
        { ...message1, atMs: 5000 },
        { ...message1, id: "m2", atMs: 0 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate message ids", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      events: [message1, { ...message1, atMs: 1000 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a replyToId that references an unknown or later message", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      events: [{ ...message1, replyToId: "m9" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects referencedMessageIds pointing to an unknown message", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      label: { ...baseLabel, referencedMessageIds: ["m9"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a reply scenario without maxWaitMs", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      label: { ...baseLabel, maxWaitMs: null },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a silence scenario with referencedMessageIds", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      label: { ...baseLabel, expectedAction: "silence", maxWaitMs: null },
    });
    expect(result.success).toBe(false);
  });
});

const conversationsDir = join(import.meta.dirname, "conversations");

describe("conversation corpus", () => {
  it("loads every scenario file with a unique name", () => {
    const scenarios = loadScenarios(conversationsDir, { characterName: "ふあ" });
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    const names = scenarios.map((entry) => entry.scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("substitutes the character name into scenario text", () => {
    const scenarios = loadScenarios(conversationsDir, { characterName: "ふあ" });
    const nameCall = scenarios.find((entry) => entry.scenario.name === "name-call-question");
    const lastEvent = nameCall?.scenario.events.at(-1);
    expect(lastEvent?.kind === "message" && lastEvent.content).toBe("ふあはどう思う？");
    for (const { scenario } of scenarios) {
      const texts = [
        scenario.description,
        scenario.label.notes ?? "",
        ...scenario.events.map((event) => (event.kind === "message" ? event.content : "")),
      ];
      expect(texts.join("\n")).not.toContain("{{character}}");
    }
  });

  it("keeps raw scenario files free of a concrete character name", () => {
    const files = readdirSync(conversationsDir).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const raw = readFileSync(join(conversationsDir, file), "utf8");
      expect(raw, `${file} must use {{character}} instead of a concrete name`).not.toContain("ふあ");
    }
  });
});
