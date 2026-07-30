import { parseArgs } from "node:util";
import { z } from "zod";

type ActorReason = { actor: string; reason: string };
export type AdminCommand =
  | { kind: "migration.status" }
  | ({ kind: "migration.apply"; backupConfirmedAt: Date } & Pick<ActorReason, "actor">)
  | ({ kind: "system.set"; mode: "running" | "draining" | "stopped" } & ActorReason)
  | { kind: "channel.show"; guildId: string; channelId: string }
  | ({
      kind: "channel.set";
      guildId: string;
      channelId: string;
      observeEvents: boolean;
      respondToMentions: boolean;
    } & ActorReason)
  | { kind: "thread.show"; guildId: string; channelId: string; threadId: string }
  | ({
      kind: "thread.set";
      guildId: string;
      channelId: string;
      threadId: string;
      observeEvents?: boolean | null;
      respondToMentions?: boolean | null;
      addReactions?: boolean | null;
    } & ActorReason)
  | ({ kind: "character.import"; path: string } & Pick<ActorReason, "actor">)
  | ({ kind: "character.activate"; characterId: string; version: number } & Pick<ActorReason, "actor">)
  | { kind: "effect.inspect"; effectId: string }
  | ({
      kind: "effect.reconcile";
      effectId: string;
      state: "succeeded" | "failed";
      externalResourceId: string | null;
    } & ActorReason);

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};
const booleanValue = (value: unknown, name: string): boolean => {
  const normalized = text(value, name);
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
};
const overrideValue = (value: unknown, name: string): boolean | null => {
  const normalized = text(value, name);
  if (normalized === "allow") return true;
  if (normalized === "deny") return false;
  if (normalized === "inherit") return null;
  throw new Error(`${name} must be allow, deny, or inherit`);
};
const snowflake = /^[0-9]{17,20}$/u;
const actorId = (value: unknown): string => {
  const normalized = text(value, "actor");
  if (!snowflake.test(normalized)) throw new Error("actor must be a Discord user ID");
  return normalized;
};
const actorReason = (values: Record<string, unknown>): ActorReason => ({
  actor: actorId(values.actor),
  reason: text(values.reason, "reason"),
});
const isoDatetime = z.iso.datetime({ offset: true });

function parse(argv: string[], options: Record<string, { type: "string" }>, positional: number) {
  try {
    const seen = new Set<string>();
    for (const argument of argv) {
      if (argument === "--") break;
      if (!argument.startsWith("--")) continue;
      const name = argument.slice(2).split("=", 1)[0] ?? "";
      if (seen.has(name)) throw new Error("duplicate option");
      seen.add(name);
    }
    const result = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    if (result.positionals.length !== positional) throw new Error("invalid positional arguments");
    return result;
  } catch {
    throw new Error("invalid command arguments");
  }
}

export function parseAdminCommand(argv: string[]): AdminCommand {
  const [group, action, ...args] = argv;
  if (!group || !action) throw new Error("command is required");
  const command = `${group}.${action}`;
  if (command === "migration.status") {
    if (args.length) throw new Error("unexpected argument");
    return { kind: "migration.status" };
  }
  if (command === "system.resume" || command === "system.drain" || command === "system.stop") {
    const result = parse(args, { actor: { type: "string" }, reason: { type: "string" } }, 0);
    const mode = command === "system.resume" ? "running" : command === "system.drain" ? "draining" : "stopped";
    return { kind: "system.set", mode, ...actorReason(result.values) };
  }
  if (command === "channel.show") {
    const result = parse(args, {}, 2);
    return {
      kind: "channel.show",
      guildId: text(result.positionals[0], "guildId"),
      channelId: text(result.positionals[1], "channelId"),
    };
  }
  if (command === "migration.apply") {
    const result = parse(args, { "backup-confirmed-at": { type: "string" }, actor: { type: "string" } }, 0);
    const value = text(result.values["backup-confirmed-at"], "backup-confirmed-at");
    const validValue = isoDatetime.safeParse(value);
    if (!validValue.success) throw new Error("invalid backup timestamp");
    return {
      kind: "migration.apply",
      backupConfirmedAt: new Date(validValue.data),
      actor: actorId(result.values.actor),
    };
  }
  if (command === "channel.set") {
    const result = parse(
      args,
      {
        observe: { type: "string" },
        mentions: { type: "string" },
        actor: { type: "string" },
        reason: { type: "string" },
      },
      2,
    );
    const [guildId, channelId] = result.positionals;
    return {
      kind: "channel.set",
      guildId: text(guildId, "guildId"),
      channelId: text(channelId, "channelId"),
      observeEvents: booleanValue(result.values.observe, "observe"),
      respondToMentions: booleanValue(result.values.mentions, "mentions"),
      ...actorReason(result.values),
    };
  }
  if (command === "thread.show") {
    const result = parse(args, {}, 3);
    const [guildId, channelId, threadId] = result.positionals;
    return {
      kind: "thread.show",
      guildId: text(guildId, "guildId"),
      channelId: text(channelId, "channelId"),
      threadId: text(threadId, "threadId"),
    };
  }
  if (command === "thread.set") {
    const result = parse(
      args,
      {
        observe: { type: "string" },
        mentions: { type: "string" },
        reactions: { type: "string" },
        actor: { type: "string" },
        reason: { type: "string" },
      },
      3,
    );
    const [guildId, channelId, threadId] = result.positionals;
    return {
      kind: "thread.set",
      guildId: text(guildId, "guildId"),
      channelId: text(channelId, "channelId"),
      threadId: text(threadId, "threadId"),
      ...(result.values.observe !== undefined
        ? { observeEvents: overrideValue(result.values.observe, "observe") }
        : {}),
      ...(result.values.mentions !== undefined
        ? { respondToMentions: overrideValue(result.values.mentions, "mentions") }
        : {}),
      ...(result.values.reactions !== undefined
        ? { addReactions: overrideValue(result.values.reactions, "reactions") }
        : {}),
      ...actorReason(result.values),
    };
  }
  if (command === "character.import") {
    const result = parse(args, { actor: { type: "string" } }, 1);
    return {
      kind: "character.import",
      path: text(result.positionals[0], "path"),
      actor: actorId(result.values.actor),
    };
  }
  if (command === "character.activate") {
    const result = parse(args, { actor: { type: "string" } }, 2);
    const version = Number(text(result.positionals[1], "version"));
    if (!Number.isInteger(version) || version < 1) throw new Error("invalid version");
    return {
      kind: "character.activate",
      characterId: text(result.positionals[0], "characterId"),
      version,
      actor: actorId(result.values.actor),
    };
  }
  if (command === "effect.inspect") {
    const result = parse(args, {}, 1);
    return { kind: "effect.inspect", effectId: text(result.positionals[0], "effectId") };
  }
  if (command === "effect.reconcile") {
    const result = parse(
      args,
      {
        state: { type: "string" },
        "external-resource-id": { type: "string" },
        actor: { type: "string" },
        reason: { type: "string" },
      },
      1,
    );
    const state = text(result.values.state, "state");
    if (state !== "succeeded" && state !== "failed") throw new Error("invalid state");
    const external = result.values["external-resource-id"];
    if (state === "succeeded" && external === undefined) throw new Error("external resource id is required");
    if (state === "failed" && external !== undefined) throw new Error("failed effect cannot have external resource id");
    return {
      kind: "effect.reconcile",
      effectId: text(result.positionals[0], "effectId"),
      state,
      externalResourceId: external === undefined ? null : text(external, "externalResourceId"),
      ...actorReason(result.values),
    };
  }
  throw new Error("unknown command");
}
