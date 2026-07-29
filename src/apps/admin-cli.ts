import { lstat, open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import type { Sql } from "postgres";
import { createPostgresClient } from "../adapters/postgres/client.js";
import { migrationStatus, runMigrations } from "../adapters/postgres/migrations.js";
import { PostgresChannelCapabilityRepository } from "../adapters/postgres/channel-capability-repository.js";
import { PostgresCharacterRepository } from "../adapters/postgres/character-repository.js";
import { PostgresEffectQueue } from "../adapters/postgres/effect-queue.js";
import { PostgresSystemControlRepository } from "../adapters/postgres/system-control-repository.js";
import { CharacterDefinitionSchema } from "../modules/characters/character-definition.js";
import type { ChannelCapabilities } from "../modules/channels/channel-capability.js";
import { loadAdminConfig } from "../config/runtime-config.js";
import { parseAdminCommand, type AdminCommand } from "../modules/admin/admin-command.js";
export interface AdminOutput {
  write(value: unknown): void;
}
type ChannelPatch = Pick<ChannelCapabilities, "observeEvents" | "respondToMentions">;
type AdminChannelRepository = Pick<PostgresChannelCapabilityRepository, "get"> & {
  patch(
    guildId: string,
    channelId: string,
    changes: ChannelPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<ChannelCapabilities>;
};
export interface AdminDependencies {
  createClient?: (url: string) => Sql;
  now?: () => Date;
  lstat?: typeof lstat;
  open?: typeof open;
  migrationStatus?: typeof migrationStatus;
  runMigrations?: typeof runMigrations;
  system?: (sql: Sql) => Pick<PostgresSystemControlRepository, "setMode">;
  channel?: (sql: Sql) => AdminChannelRepository;
  character?: (sql: Sql) => Pick<PostgresCharacterRepository, "importDraft" | "activate">;
  effect?: (sql: Sql) => Pick<PostgresEffectQueue, "inspect" | "reconcileUnknown">;
  output?: AdminOutput;
}
const write = (d: AdminDependencies, v: unknown) =>
  (d.output ?? { write: (x: unknown) => console.log(JSON.stringify(x)) }).write(v);
const clock = (d: AdminDependencies) => (d.now ?? (() => new Date()))();
const MAX_CHARACTER_FILE_BYTES = 64 * 1024;

async function readCharacterFile(path: string, d: AdminDependencies): Promise<string> {
  const initial = await (d.lstat ?? lstat)(path);
  if (!initial.isFile()) throw new Error("character file must be regular");
  if (initial.size > MAX_CHARACTER_FILE_BYTES) throw new Error("character file is too large");
  let handle: FileHandle | undefined;
  try {
    handle = await (d.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = await handle.stat();
    if (!current.isFile()) throw new Error("character file must be regular");
    if (current.size > MAX_CHARACTER_FILE_BYTES) throw new Error("character file is too large");
    const buffer = Buffer.alloc(MAX_CHARACTER_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      if (offset > MAX_CHARACTER_FILE_BYTES) throw new Error("character file is too large");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await handle?.close();
  }
}
export async function dispatchAdminCommand(
  command: AdminCommand,
  sql: Sql,
  config: ReturnType<typeof loadAdminConfig>,
  d: AdminDependencies = {},
): Promise<void> {
  switch (command.kind) {
    case "migration.status":
      write(d, await (d.migrationStatus ?? migrationStatus)(sql, config.migrationsDir));
      return;
    case "migration.apply": {
      const confirmedAt = command.backupConfirmedAt.getTime();
      if (!Number.isFinite(confirmedAt)) throw new Error("backup confirmation is invalid");
      const age = clock(d).getTime() - confirmedAt;
      if (age < 0 || age > 86400000) throw new Error("backup confirmation is stale");
      const result = await (d.runMigrations ?? runMigrations)(sql, config.migrationsDir, {
        actor: command.actor,
        backupConfirmedAt: command.backupConfirmedAt,
      });
      write(d, {
        applied: result.appliedVersions.length > 0,
        appliedVersions: result.appliedVersions,
        actor: command.actor,
      });
      return;
    }
    case "system.set": {
      const r = (d.system ?? ((db) => new PostgresSystemControlRepository(db)))(sql);
      await r.setMode(command.mode, command.actor, command.reason, clock(d));
      write(d, { mode: command.mode });
      return;
    }
    case "channel.show": {
      const r = (d.channel ?? ((db) => new PostgresChannelCapabilityRepository(db)))(sql);
      write(d, await r.get(command.guildId, command.channelId));
      return;
    }
    case "channel.set": {
      const r = (
        d.channel ?? ((db) => new PostgresChannelCapabilityRepository(db) as unknown as AdminChannelRepository)
      )(sql);
      const next = await r.patch(
        command.guildId,
        command.channelId,
        { observeEvents: command.observeEvents, respondToMentions: command.respondToMentions },
        command.actor,
        command.reason,
        clock(d),
      );
      write(d, next);
      return;
    }
    case "character.import": {
      const value = CharacterDefinitionSchema.parse(JSON.parse(await readCharacterFile(command.path, d)));
      await (d.character ?? ((db) => new PostgresCharacterRepository(db)))(sql).importDraft(
        value,
        command.actor,
        clock(d),
      );
      write(d, { imported: `${value.characterId}@${value.version}` });
      return;
    }
    case "character.activate":
      await (d.character ?? ((db) => new PostgresCharacterRepository(db)))(sql).activate(
        command.characterId,
        command.version,
        command.actor,
        clock(d),
      );
      write(d, { activated: `${command.characterId}@${command.version}` });
      return;
    case "effect.inspect": {
      const r = (d.effect ?? ((db) => new PostgresEffectQueue(db)))(sql);
      write(d, await r.inspect(command.effectId));
      return;
    }
    case "effect.reconcile": {
      const r = (d.effect ?? ((db) => new PostgresEffectQueue(db)))(sql);
      await r.reconcileUnknown(
        command.effectId,
        command.state,
        command.externalResourceId,
        command.actor,
        command.reason,
        clock(d),
      );
      write(d, { reconciled: command.effectId, state: command.state });
      return;
    }
  }
}
export async function main(argv = process.argv.slice(2), env = process.env, d: AdminDependencies = {}): Promise<void> {
  let sql: Sql | undefined;
  let dispatchFailed = false;
  let closeFailed = false;
  try {
    const config = loadAdminConfig(env);
    sql = (d.createClient ?? createPostgresClient)(config.databaseUrl);
    await dispatchAdminCommand(parseAdminCommand(argv), sql, config, d);
  } catch {
    dispatchFailed = true;
  } finally {
    if (sql) {
      try {
        await sql.end();
      } catch {
        closeFailed = true;
      }
    }
  }
  if (dispatchFailed) {
    console.error("Admin command failed");
    process.exitCode = 1;
  } else if (closeFailed) {
    console.error("Admin command succeeded, but closing the database connection failed");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  void main().catch(() => {
    console.error("Admin command failed");
    process.exitCode = 1;
  });
