import { Client, GatewayIntentBits, type Message } from "discord.js";
import type { Sql } from "postgres";
import { createPostgresClient } from "../adapters/postgres/client.js";
import { migrationStatus } from "../adapters/postgres/migrations.js";
import { PostgresIngestionStore } from "../adapters/postgres/ingestion-store.js";
import { PostgresChannelCapabilityRepository } from "../adapters/postgres/channel-capability-repository.js";
import { PostgresThreadCapabilityRepository } from "../adapters/postgres/thread-capability-repository.js";
import { PostgresEffectiveCapabilityRepository } from "../adapters/postgres/effective-capability-repository.js";
import { PostgresSystemControlRepository } from "../adapters/postgres/system-control-repository.js";
import { PostgresEffectQueue } from "../adapters/postgres/effect-queue.js";
import { DiscordClientMessenger, snapshotDiscordMessage } from "../adapters/discord/discord-client.js";
import { DiscordEffectExecutor } from "../adapters/discord/discord-effect-executor.js";
import { toDiscordMessageInput, toTypingScope } from "../adapters/discord/message-snapshot.js";
import { channelCommand, handleChannelCommand } from "../adapters/discord/channel-command.js";
import { ingestDiscordMessage } from "../modules/events/ingest-message.js";
import { runOneEffect } from "../modules/effects/run-effect-worker.js";
import { loadGatewayConfig } from "../config/runtime-config.js";
import { createLogger } from "../observability/logger.js";
import { createHealthServer } from "../shared/health-server.js";
import { sleep, shutdownSignal } from "../shared/process-lifecycle.js";
import { SystemClock } from "../shared/clock.js";
import { createInFlightTracker, requireNoPendingMigrations } from "./app-lifecycle.js";
import { acquireGatewayLease } from "../adapters/postgres/gateway-lease.js";

export function isGatewayMessageInScope(
  message: { guildId: string | null; author: { id: string; bot: boolean } },
  config: { guildId: string; botUserId?: string },
): boolean {
  return message.guildId === config.guildId && message.author.id !== config.botUserId;
}
export interface GatewayDependencies {
  sql: Sql;
  client: Client<true>;
  config: ReturnType<typeof loadGatewayConfig>;
  health: ReturnType<typeof createHealthServer>;
  logger: ReturnType<typeof createLogger>;
  shutdown: Promise<AbortSignal>;
  prepared?: boolean;
  startClient?: () => Promise<void>;
  registerCommands?: () => Promise<void>;
  accepting?: { value: boolean };
  inflight?: ReturnType<typeof createInFlightTracker>;
}

export function registerGatewayListeners(
  client: { on(event: string, listener: (...args: any[]) => void): unknown },
  handlers: {
    messageCreate: (...args: any[]) => void;
    interactionCreate: (...args: any[]) => void;
    typingStart: (...args: any[]) => void;
  },
): void {
  client.on("messageCreate", handlers.messageCreate);
  client.on("interactionCreate", handlers.interactionCreate);
  client.on("typingStart", handlers.typingStart);
}
export async function startGatewayClient(
  client: {
    login(token: string): Promise<unknown>;
    guilds: { fetch(id: string): Promise<{ commands: { set(commands: unknown[]): Promise<unknown> } }> };
  },
  token: string,
  guildId: string,
  command: unknown,
): Promise<void> {
  await client.login(token);
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([command]);
}
export async function cleanupGateway(steps: {
  stop(): void;
  destroy(): Promise<void>;
  drain(): Promise<void>;
  release(): Promise<void>;
  end(): Promise<void>;
}): Promise<void> {
  steps.stop();
  const errors: unknown[] = [];
  for (const action of [() => steps.destroy(), () => steps.drain(), () => steps.release(), () => steps.end()]) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Gateway cleanup failed");
}
export function handleGatewayFatal(
  accepting: { value: boolean },
  health: { setReady(ready: boolean): void },
  fatal: (error: unknown) => void,
  error: unknown,
): void {
  accepting.value = false;
  health.setReady(false);
  fatal(error);
}

export async function runGateway(d: GatewayDependencies): Promise<void> {
  const { sql, client, config, health, logger } = d;
  if (!d.prepared) requireNoPendingMigrations(await migrationStatus(sql, config.migrationsDir));
  const channelCapabilities = new PostgresChannelCapabilityRepository(sql);
  const threadCapabilities = new PostgresThreadCapabilityRepository(sql);
  const effectiveCapabilities = new PostgresEffectiveCapabilityRepository(channelCapabilities, threadCapabilities);
  const system = new PostgresSystemControlRepository(sql);
  await system.get();
  const ingestion = new PostgresIngestionStore(sql);
  const effects = new PostgresEffectQueue(sql);
  const messenger = new DiscordClientMessenger(client, config.guildId);
  const executor = new DiscordEffectExecutor(messenger, effects);
  if (!d.prepared) await effects.recoverExecutingAsUnknown(SystemClock.now());
  const accepting = d.accepting ?? { value: false };
  const inflight = d.inflight ?? createInFlightTracker();
  let rejectFatal!: (error: unknown) => void;
  const fatal = new Promise<never>((_, reject) => {
    rejectFatal = reject;
  });
  void fatal.catch(() => undefined);
  const onMessage = (message: Message) => {
    if (
      !accepting.value ||
      !client.user ||
      !isGatewayMessageInScope(message, { guildId: config.guildId, botUserId: client.user.id })
    )
      return;
    const task = (async () => {
      const snapshot = snapshotDiscordMessage(message);
      const input = toDiscordMessageInput(snapshot, client.user!.id);
      const capability = await effectiveCapabilities.get(config.guildId, input.channelId, input.threadId);
      const mode = await system.get();
      const result = await ingestDiscordMessage(input, capability, mode.mode, config.batch, ingestion, SystemClock);
      logger.debug(
        {
          channelId: input.channelId,
          threadId: input.threadId,
          mode: mode.mode,
          ...(result.kind === "ignored"
            ? { reason: result.reason }
            : { duplicate: result.duplicate, jobQueued: result.jobQueued, jobExtended: result.jobExtended }),
        },
        result.kind === "ignored" ? "Discord message ignored" : "Discord message ingested",
      );
    })().catch((error) => {
      handleGatewayFatal(accepting, health, rejectFatal, error);
      logger.error({ err: error }, "Discord ingestion failed");
    });
    inflight.track(task).catch(() => undefined);
  };
  const onInteraction = (interaction: Parameters<NonNullable<Parameters<Client["on"]>[1]>>[0]) => {
    if (
      !accepting.value ||
      !interaction.isChatInputCommand() ||
      interaction.commandName !== channelCommand.name ||
      !interaction.guildId ||
      interaction.guildId !== config.guildId ||
      !interaction.inCachedGuild()
    )
      return;
    const commandRepository = {
      get: channelCapabilities.get.bind(channelCapabilities),
      patch: async (...args: Parameters<typeof channelCapabilities.patch>) => {
        await channelCapabilities.patch(...args);
      },
      getThread: threadCapabilities.get.bind(threadCapabilities),
      patchThread: async (...args: Parameters<typeof threadCapabilities.patch>) => {
        await threadCapabilities.patch(...args);
      },
    };
    inflight
      .track(
        handleChannelCommand(interaction, config.guildId, new Set(config.adminIds), commandRepository, SystemClock),
      )
      .catch((error) => logger.error({ err: error }, "Interaction failed"));
  };
  const onTyping = (typing: import("discord.js").Typing) => {
    if (!accepting.value) return;
    const scope = toTypingScope({
      guildId: typing.guild?.id ?? null,
      channelId: typing.channel.id,
      parentChannelId: typing.channel.isThread() ? typing.channel.parentId : null,
      isThread: typing.channel.isThread(),
      userIsBot: typing.user.bot ?? false,
    });
    if (!scope || scope.guildId !== config.guildId) return;
    const now = SystemClock.now();
    inflight
      .track(
        ingestion.extendQueuedJob({
          ...scope,
          availableAt: new Date(now.getTime() + config.batch.batchWindowMs),
          maxWaitMs: config.batch.maxWaitMs,
          now,
        }),
      )
      .catch((error) => logger.warn({ err: error }, "Typing extension failed"));
  };
  accepting.value = true;
  registerGatewayListeners(client, {
    messageCreate: onMessage as never,
    interactionCreate: onInteraction as never,
    typingStart: onTyping as never,
  });
  await d.startClient?.();
  await d.registerCommands?.();
  health.setReady(true);
  const controller = new AbortController();
  const effectLoop = runEffectLoop(effects, effectiveCapabilities, executor, controller.signal, logger, rejectFatal);
  let fatalError: unknown;
  try {
    await Promise.race([d.shutdown, fatal]);
  } catch (error) {
    fatalError = error;
  } finally {
    controller.abort();
    accepting.value = false;
    health.setReady(false);
    await effectLoop;
  }
  if (fatalError !== undefined) throw fatalError;
}
async function runEffectLoop(
  queue: PostgresEffectQueue,
  capabilities: PostgresEffectiveCapabilityRepository,
  executor: DiscordEffectExecutor,
  signal: AbortSignal,
  logger: ReturnType<typeof createLogger>,
  fatal: (error: unknown) => void,
): Promise<void> {
  while (!signal.aborted) {
    try {
      if (!(await runOneEffect(queue, capabilities, executor, "discord-gateway", SystemClock)))
        await sleep(250, signal);
    } catch (error) {
      logger.error({ err: error }, "Effect execution failed");
      fatal(error);
      return;
    }
  }
}
export async function main(env = process.env): Promise<void> {
  const config = loadGatewayConfig(env);
  const logger = createLogger({ level: config.logLevel });
  const health = createHealthServer({ ready: false });
  let sql: Sql | undefined;
  let lease: { release(): Promise<void> } | undefined;
  const accepting = { value: false };
  const inflight = createInFlightTracker();
  let primaryError: unknown;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
    ],
  });
  try {
    sql = createPostgresClient(config.databaseUrl);
    await health.listen(config.healthPort);
    lease = await acquireGatewayLease(sql);
    requireNoPendingMigrations(await migrationStatus(sql, config.migrationsDir));
    await new PostgresEffectQueue(sql).recoverExecutingAsUnknown(SystemClock.now());
    await runGateway({
      sql,
      client: client as Client<true>,
      config,
      health,
      logger,
      shutdown: shutdownSignal(),
      prepared: true,
      startClient: async () => {
        await client.login(config.discordToken);
      },
      registerCommands: async () => {
        const guild = await client.guilds.fetch(config.guildId);
        await guild.commands.set([channelCommand.toJSON()]);
      },
      accepting,
      inflight,
    });
  } catch (error) {
    primaryError = error;
    logger.error("Discord gateway failed");
    process.exitCode = 1;
  } finally {
    health.setReady(false);
    try {
      await cleanupGateway({
        stop: () => {
          accepting.value = false;
        },
        destroy: () => client.destroy(),
        drain: () => inflight.drain(),
        release: () => lease?.release() ?? Promise.resolve(),
        end: () => sql?.end() ?? Promise.resolve(),
      });
    } catch (error) {
      primaryError = primaryError === undefined ? error : new AggregateError([primaryError, error], "Gateway failed");
    }
    await health.close().catch(() => undefined);
  }
  if (primaryError !== undefined) throw primaryError;
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  void main().catch(() => {
    console.error("Discord gateway failed");
    process.exitCode = 1;
  });
