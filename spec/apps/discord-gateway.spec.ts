import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../src/adapters/postgres/client.js";
import { runMigrations } from "../../src/adapters/postgres/migrations.js";
import { runGateway } from "../../src/apps/discord-gateway.js";

const url = process.env.TEST_DATABASE_URL;
let sql: Sql;

beforeAll(async () => {
  sql = createPostgresClient(url!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

afterAll(async () => {
  await sql.end();
});

describe("runGateway", () => {
  it("checks the system singleton before connecting to Discord", async () => {
    const savedRows = await sql<
      { singleton: boolean; mode: string; updatedAt: Date; updatedBy: string; reason: string }[]
    >`select singleton, mode, updated_at as "updatedAt", updated_by as "updatedBy", reason from system_state where singleton`;
    const saved = savedRows[0];
    if (!saved) throw new Error("System state singleton is missing before test");
    await sql`delete from system_state`;
    const order: string[] = [];
    const accepting = { value: false };
    const health = { setReady: vi.fn((ready: boolean) => order.push(`ready:${ready}`)) };
    const client = {
      on: vi.fn(() => order.push("listener")),
      user: null,
    };
    const startClient = vi.fn(async () => {
      order.push("login");
    });
    const registerCommands = vi.fn(async () => {
      order.push("commands");
    });

    try {
      await expect(
        runGateway({
          sql,
          client: client as never,
          config: {
            migrationsDir: "migrations",
            guildId: "guild",
            adminIds: ["admin"],
            discordToken: "token",
          } as never,
          health: health as never,
          logger: { error: vi.fn() } as never,
          shutdown: Promise.resolve(new AbortController().signal),
          prepared: true,
          startClient,
          registerCommands,
          accepting,
        }),
      ).rejects.toThrow("System state singleton is missing");
      expect(startClient).not.toHaveBeenCalled();
      expect(registerCommands).not.toHaveBeenCalled();
      expect(client.on).not.toHaveBeenCalled();
      expect(accepting.value).toBe(false);
      expect(health.setReady).not.toHaveBeenCalledWith(true);
      expect(order).toEqual([]);
    } finally {
      await sql`insert into system_state (singleton, mode, updated_at, updated_by, reason) values (${saved.singleton}, ${saved.mode}, ${saved.updatedAt}, ${saved.updatedBy}, ${saved.reason})`;
    }
  });
});
