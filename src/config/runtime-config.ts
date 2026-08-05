import { z } from "zod";
import { DEFAULT_BATCH_CONFIG } from "../modules/conversations/batch-schedule.js";

const envString = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1);
const database = z
  .string()
  .trim()
  .refine((v) => /^postgres(?:ql)?:\/\//u.test(v), "DATABASE_URL must use postgres protocol");
const common = z
  .object({
    DATABASE_URL: database,
    VICISSITUDE_CHARACTER_ID: z.string().trim().min(1).default("primary"),
    VICISSITUDE_MODEL_ROUTES_PATH: z.string().trim().min(1).default("config/model-routes.json"),
    VICISSITUDE_MIGRATIONS_DIR: z.string().trim().min(1).default("migrations"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  })
  .passthrough();
const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);
const raw = (input: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
export type CommonConfig = z.infer<typeof common>;
export function loadGatewayConfig(input: NodeJS.ProcessEnv) {
  const value = common
    .extend({
      DISCORD_TOKEN: envString("DISCORD_TOKEN"),
      VICISSITUDE_GUILD_ID: envString("VICISSITUDE_GUILD_ID"),
      VICISSITUDE_ADMIN_USER_IDS: z
        .string()
        .transform((v) =>
          v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        )
        .refine((v) => v.length > 0, "at least one admin id"),
      VICISSITUDE_GATEWAY_HEALTH_PORT: port(8080),
      VICISSITUDE_BATCH_WINDOW_MS: z.coerce.number().int().positive().default(DEFAULT_BATCH_CONFIG.batchWindowMs),
      VICISSITUDE_MAX_WAIT_MS: z.coerce.number().int().positive().default(DEFAULT_BATCH_CONFIG.maxWaitMs),
    })
    .parse(raw(input));
  if (value.VICISSITUDE_ADMIN_USER_IDS.some((id) => /\s/u.test(id)))
    throw new Error("admin IDs must not contain whitespace");
  if (value.VICISSITUDE_MAX_WAIT_MS < value.VICISSITUDE_BATCH_WINDOW_MS)
    throw new Error("VICISSITUDE_MAX_WAIT_MS must be >= VICISSITUDE_BATCH_WINDOW_MS");
  return {
    databaseUrl: value.DATABASE_URL,
    characterId: value.VICISSITUDE_CHARACTER_ID,
    modelRoutesPath: value.VICISSITUDE_MODEL_ROUTES_PATH,
    migrationsDir: value.VICISSITUDE_MIGRATIONS_DIR,
    logLevel: value.LOG_LEVEL,
    discordToken: value.DISCORD_TOKEN,
    guildId: value.VICISSITUDE_GUILD_ID,
    adminIds: value.VICISSITUDE_ADMIN_USER_IDS,
    healthPort: value.VICISSITUDE_GATEWAY_HEALTH_PORT,
    batch: { batchWindowMs: value.VICISSITUDE_BATCH_WINDOW_MS, maxWaitMs: value.VICISSITUDE_MAX_WAIT_MS },
  };
}
export function loadWorkerConfig(input: NodeJS.ProcessEnv) {
  const value = common
    .extend({
      VICISSITUDE_WORKER_ID: z.string().trim().min(1).default("cognition-1"),
      VICISSITUDE_WORKER_HEALTH_PORT: port(8081),
    })
    .parse(raw(input));
  return {
    databaseUrl: value.DATABASE_URL,
    characterId: value.VICISSITUDE_CHARACTER_ID,
    modelRoutesPath: value.VICISSITUDE_MODEL_ROUTES_PATH,
    migrationsDir: value.VICISSITUDE_MIGRATIONS_DIR,
    logLevel: value.LOG_LEVEL,
    workerId: value.VICISSITUDE_WORKER_ID,
    healthPort: value.VICISSITUDE_WORKER_HEALTH_PORT,
  };
}
export function loadAdminConfig(input: NodeJS.ProcessEnv) {
  const value = common.parse(raw(input));
  return {
    databaseUrl: value.DATABASE_URL,
    characterId: value.VICISSITUDE_CHARACTER_ID,
    modelRoutesPath: value.VICISSITUDE_MODEL_ROUTES_PATH,
    migrationsDir: value.VICISSITUDE_MIGRATIONS_DIR,
    logLevel: value.LOG_LEVEL,
  };
}
