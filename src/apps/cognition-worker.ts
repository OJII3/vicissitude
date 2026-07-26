import type { Sql } from "postgres";
import { createPostgresClient } from "../adapters/postgres/client.js";
import { migrationStatus } from "../adapters/postgres/migrations.js";
import { PostgresCharacterRepository } from "../adapters/postgres/character-repository.js";
import { PostgresJobQueue } from "../adapters/postgres/job-queue.js";
import { PostgresDecisionEffectStore } from "../adapters/postgres/decision-effect-store.js";
import { createPiModels } from "../adapters/pi/pi-models.js";
import { PiAgentRuntime } from "../adapters/pi/pi-agent-runtime.js";
import { loadModelRoutes } from "../config/model-routes.js";
import { loadWorkerConfig } from "../config/runtime-config.js";
import { createLogger } from "../observability/logger.js";
import { processMention, handleMentionFailure } from "../modules/mentions/process-mention.js";
import { runWorkerIteration } from "./app-lifecycle.js";
import { createHealthServer } from "../shared/health-server.js";
import { sleep, shutdownSignal } from "../shared/process-lifecycle.js";
import { SystemClock } from "../shared/clock.js";

export interface CognitionDependencies {
  sql: Sql;
  migrationStatus: typeof migrationStatus;
  closeSql: () => Promise<void>;
  health: ReturnType<typeof createHealthServer>;
  sleep: typeof sleep;
  shutdown: Promise<AbortSignal>;
  now: () => Date;
  logger: ReturnType<typeof createLogger>;
}

export async function runCognitionWorker(
  config: ReturnType<typeof loadWorkerConfig>,
  d: CognitionDependencies,
): Promise<void> {
  const statuses = await d.migrationStatus(d.sql, config.migrationsDir);
  if (statuses.some((status) => status.state === "pending")) throw new Error("pending migrations");
  const characterRepo = new PostgresCharacterRepository(d.sql);
  const character = await characterRepo.getProduction(config.characterId);
  if (!character) throw new Error("production character is required");
  const routes = await loadModelRoutes(config.modelRoutesPath);
  const runtime = new PiAgentRuntime(createPiModels());
  const queue = new PostgresJobQueue(d.sql);
  const store = new PostgresDecisionEffectStore(d.sql);
  const stopping = { value: false };
  void d.shutdown.then(() => {
    stopping.value = true;
  });
  d.health.setReady(true);
  while (!stopping.value) {
    try {
      const handled = await runWorkerIteration(
        queue,
        config.workerId,
        d.now(),
        (job) => processMention(job, character, routes, runtime, store, { now: d.now }),
        (job, error) => handleMentionFailure(job, error, queue, store, { now: d.now }),
      );
      if (stopping.value) {
        d.health.setReady(false);
        break;
      }
      d.health.setReady(true);
      if (!handled) await d.sleep(250);
    } catch (error) {
      d.health.setReady(false);
      d.logger.error({ err: error }, "Cognition iteration failed");
      await d.sleep(250).catch(() => undefined);
    }
  }
}

export async function main(env = process.env): Promise<void> {
  let sql: Sql | undefined;
  const config = loadWorkerConfig(env);
  const logger = createLogger({ level: config.logLevel });
  const health = createHealthServer({ ready: false });
  try {
    sql = createPostgresClient(config.databaseUrl);
    await health.listen(config.healthPort);
    await runCognitionWorker(config, {
      sql,
      migrationStatus,
      closeSql: () => sql!.end(),
      health,
      sleep,
      shutdown: shutdownSignal(),
      now: () => SystemClock.now(),
      logger,
    });
  } catch {
    logger.error("Cognition worker failed");
    process.exitCode = 1;
  } finally {
    health.setReady(false);
    await health.close().catch(() => undefined);
    await sql?.end().catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  void main().catch(() => {
    console.error("Cognition worker failed");
    process.exitCode = 1;
  });
