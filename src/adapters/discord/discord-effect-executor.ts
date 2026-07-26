import type { ClaimedReplyEffect, EffectQueue } from "../../modules/effects/effect.js";
import type { Clock } from "../../shared/clock.js";
import { effectNonce } from "../../modules/effects/effect.js";

export interface DiscordMessenger {
  reply(input: {
    guildId: string;
    channelId: string;
    messageId: string;
    content: string;
    nonce: string;
    enforceNonce: true;
    allowedMentions: { parse: []; repliedUser: false };
  }): Promise<{ id: string }>;
}

export class DiscordRequestRejectedError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordRequestRejectedError";
  }
}

export class DiscordEffectExecutor {
  public constructor(
    private readonly messenger: DiscordMessenger,
    private readonly queue: EffectQueue,
  ) {}

  public async execute(effect: ClaimedReplyEffect, clock: Clock): Promise<void> {
    let result: { id: string };
    try {
      result = await this.messenger.reply({
        channelId: effect.targetChannelId,
        guildId: effect.guildId,
        messageId: effect.targetMessageId,
        content: effect.content,
        nonce: effectNonce(effect.id),
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
      if (error instanceof DiscordRequestRejectedError || (status >= 400 && status <= 499)) {
        await this.queue.fail(effect.id, "discord_request_failed", clock.now());
      } else {
        await this.queue.markUnknown(effect.id, "discord_delivery_unknown", clock.now());
      }
      return;
    }
    try {
      await this.queue.succeed(effect.id, result.id, clock.now());
    } catch (transitionError) {
      try {
        await this.queue.markUnknown(effect.id, "effect_state_persistence_failed", clock.now());
      } catch (unknownError) {
        throw new AggregateError([transitionError, unknownError], "Effect state persistence failed");
      }
    }
  }
}
