import { createHash } from "node:crypto";
import { z } from "zod";

export const DiscordReplyPayloadSchema = z.strictObject({
  content: z.string().trim().min(1).max(600),
  allowedMentions: z.strictObject({ parse: z.tuple([]), repliedUser: z.literal(false) }),
});
export type DiscordReplyPayload = z.infer<typeof DiscordReplyPayloadSchema>;
export type EffectState = "planned" | "executing" | "succeeded" | "failed" | "unknown";
export interface ClaimedReplyEffect {
  id: string;
  runId: string;
  guildId: string;
  capabilityChannelId: string;
  targetChannelId: string;
  threadId: string | null;
  targetMessageId: string;
  content: string;
  attempts: number;
}
export interface EffectQueue {
  succeed(id: string, externalResourceId: string, now: Date): Promise<void>;
  fail(id: string, error: string, now: Date): Promise<void>;
  markUnknown(id: string, error: string, now: Date): Promise<void>;
}
export function effectNonce(effectId: string): string {
  return createHash("sha256").update(effectId).digest("base64url").slice(0, 22);
}
