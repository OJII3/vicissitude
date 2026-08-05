import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_CONFIG, extendedAvailableAt } from "../../src/modules/conversations/batch-schedule.js";
import { loadScenarios, type ConversationScenario } from "./scenario.js";

const conversationsDir = resolve(import.meta.dirname, "conversations");
const base = Date.UTC(2026, 0, 1);
const at = (ms: number) => new Date(base + ms);

type ScenarioEvent = ConversationScenario["events"][number];
const scopeKey = (event: ScenarioEvent) => `${event.channelId}|${event.threadId ?? ""}`;

/** 最初の mention が作る job の発火時刻と scope を、ingest/typing の延長式で再生する。 */
function simulateFirstJob(events: ScenarioEvent[]) {
  let job: { scope: string; triggerAtMs: number; availableAtMs: number } | null = null;
  for (const event of events) {
    if (job && event.atMs >= job.availableAtMs) break;
    if (!job) {
      if (event.kind === "message" && event.mentionsBot) {
        job = {
          scope: scopeKey(event),
          triggerAtMs: event.atMs,
          availableAtMs: extendedAvailableAt(at(event.atMs), at(event.atMs), DEFAULT_BATCH_CONFIG).getTime() - base,
        };
      }
      continue;
    }
    if (scopeKey(event) !== job.scope) continue;
    job.availableAtMs = extendedAvailableAt(at(event.atMs), at(job.triggerAtMs), DEFAULT_BATCH_CONFIG).getTime() - base;
  }
  return job;
}

describe("batch parameters against the scenario corpus", () => {
  const scenarios = loadScenarios(conversationsDir, { characterName: "テスト" }).filter(
    ({ scenario }) =>
      scenario.label.expectedAction === "reply" &&
      scenario.events.some((event) => event.kind === "message" && event.mentionsBot),
  );

  it("covers at least the explicit-mention scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
  });

  it.each(scenarios.map(({ file, scenario }) => [file, scenario] as const))(
    "%s: fires within maxWaitMs after batching every referenced message",
    (_file, scenario) => {
      const job = simulateFirstJob(scenario.events);
      expect(job).not.toBeNull();
      const batched = new Set(
        scenario.events
          .filter(
            (event) => event.kind === "message" && scopeKey(event) === job!.scope && event.atMs <= job!.availableAtMs,
          )
          .map((event) => (event.kind === "message" ? event.id : "")),
      );
      for (const id of scenario.label.referencedMessageIds) expect(batched).toContain(id);
      expect(job!.availableAtMs - job!.triggerAtMs).toBeLessThanOrEqual(scenario.label.maxWaitMs!);
    },
  );
});
