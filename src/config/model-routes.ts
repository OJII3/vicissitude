import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
const Target = z.strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  timeoutMs: z.number().int().min(1000).max(30000),
});
export type ModelTarget = z.infer<typeof Target>;
const Schema = z.strictObject({
  schemaVersion: z.literal(1),
  routes: z.strictObject({
    mention_response: z.strictObject({
      deadlineMs: z.number().int().min(5000).max(25000),
      targets: z.array(Target).min(1).max(5),
    }),
  }),
});
export interface LoadedModelRoutes {
  version: string;
  mentionResponseDeadlineMs: number;
  mentionResponse: ModelTarget[];
}
export async function loadModelRoutes(path: string): Promise<LoadedModelRoutes> {
  const raw = await readFile(path, "utf8");
  const parsed = Schema.parse(JSON.parse(raw));
  return {
    version: createHash("sha256").update(raw).digest("hex"),
    mentionResponseDeadlineMs: parsed.routes.mention_response.deadlineMs,
    mentionResponse: parsed.routes.mention_response.targets,
  };
}
