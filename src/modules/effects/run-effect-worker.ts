import type { Clock } from "../../shared/clock.js";
import type { EffectiveCapabilityRepository } from "../channels/channel-capability.js";
import type { ClaimedReplyEffect, EffectQueue } from "./effect.js";

interface Executor {
  execute(effect: ClaimedReplyEffect, clock: Clock): Promise<void>;
}
interface Queue extends Pick<EffectQueue, "fail"> {
  claim(workerId: string, now: Date): Promise<ClaimedReplyEffect | null>;
}

export async function runOneEffect(
  queue: Queue,
  capabilities: EffectiveCapabilityRepository,
  executor: Executor,
  workerId: string,
  clock: Clock,
): Promise<boolean> {
  const effect = await queue.claim(workerId, clock.now());
  if (!effect) return false;
  // decision-effect-store writes target_channel_id = thread_id ?? channel_id, so equality means "not a thread".
  const threadId = effect.targetChannelId === effect.capabilityChannelId ? null : effect.targetChannelId;
  const capability = await capabilities.get(effect.guildId, effect.capabilityChannelId, threadId);
  if (!capability.respondToMentions) {
    await queue.fail(effect.id, "capability_revoked", clock.now());
    return true;
  }
  await executor.execute(effect, clock);
  return true;
}
