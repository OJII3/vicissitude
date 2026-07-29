import { mkdtemp, open as fsOpen, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchAdminCommand, main } from "./admin-cli.js";
const config = {
  databaseUrl: "postgres://db",
  characterId: "primary",
  modelRoutesPath: "routes",
  migrationsDir: "migrations",
  logLevel: "info",
} as const;
const sql = {} as never;
const at = new Date("2026-07-24T00:00:00Z");
const out = () => ({ write: vi.fn() });
describe("admin dispatch", () => {
  it("status never applies", async () => {
    const status = vi.fn(async () => []);
    const apply = vi.fn(async () => ({ appliedVersions: ["0001"], appliedAt: at }));
    const output = out();
    await dispatchAdminCommand({ kind: "migration.status" }, sql, config, {
      migrationStatus: status as never,
      runMigrations: apply,
      output,
    });
    expect(status).toHaveBeenCalledWith(sql, "migrations");
    expect(apply).not.toHaveBeenCalled();
    expect(output.write).toHaveBeenCalledWith([]);
  });
  it("applies only fresh backups", async () => {
    const apply = vi.fn(async () => ({ appliedVersions: ["0001"], appliedAt: at }));
    const output = out();
    const d = { runMigrations: apply, now: () => at, output };
    await dispatchAdminCommand(
      { kind: "migration.apply", backupConfirmedAt: new Date("2026-07-23T12:00:00Z"), actor: "a" },
      sql,
      config,
      d,
    );
    expect(apply).toHaveBeenCalledWith(sql, "migrations", {
      actor: "a",
      backupConfirmedAt: new Date("2026-07-23T12:00:00Z"),
    });
    expect(output.write).toHaveBeenCalledWith({ applied: true, appliedVersions: ["0001"], actor: "a" });
    await expect(
      dispatchAdminCommand(
        { kind: "migration.apply", backupConfirmedAt: new Date("2026-07-24T00:00:01Z"), actor: "a" },
        sql,
        config,
        d,
      ),
    ).rejects.toThrow();
    expect(apply).toHaveBeenCalledOnce();
    await expect(
      dispatchAdminCommand(
        { kind: "migration.apply", backupConfirmedAt: new Date("invalid"), actor: "a" },
        sql,
        config,
        d,
      ),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand(
        { kind: "migration.apply", backupConfirmedAt: new Date("2026-07-22T23:59:59Z"), actor: "a" },
        sql,
        config,
        d,
      ),
    ).rejects.toThrow();
    expect(apply).toHaveBeenCalledOnce();
  });
  it("calls system.set exactly", async () => {
    const setMode = vi.fn(async () => undefined);
    const output = out();
    await dispatchAdminCommand({ kind: "system.set", mode: "draining", actor: "a", reason: "r" }, sql, config, {
      system: () => ({ setMode }) as never,
      now: () => at,
      output,
    });
    expect(setMode).toHaveBeenCalledWith("draining", "a", "r", at);
    expect(output.write).toHaveBeenCalledWith({ mode: "draining" });
  });
  it("patches channel capabilities and writes the returned value", async () => {
    const value = {
      guildId: "g",
      channelId: "c",
      observeEvents: false,
      respondToMentions: false,
      spontaneousJoin: true,
      spontaneousTopic: false,
      addReactions: true,
      createThreads: false,
      shareFiles: true,
      shareExternalLinks: false,
    };
    const get = vi.fn(async () => value);
    const set = vi.fn(async () => undefined);
    const patch = vi.fn(async () => ({ ...value, observeEvents: true, respondToMentions: true }));
    const output = out();
    const expectedNext = { ...value, observeEvents: true, respondToMentions: true };
    await dispatchAdminCommand(
      {
        kind: "channel.set",
        guildId: "g",
        channelId: "c",
        observeEvents: true,
        respondToMentions: true,
        actor: "a",
        reason: "r",
      },
      sql,
      config,
      { channel: () => ({ get, set, patch }), now: () => at, output },
    );
    expect(patch).toHaveBeenCalledWith("g", "c", { observeEvents: true, respondToMentions: true }, "a", "r", at);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(output.write).toHaveBeenCalledWith(expectedNext);
    expect(output.write.mock.calls[0]?.[0]).toEqual(expectedNext);
    await dispatchAdminCommand({ kind: "channel.show", guildId: "g", channelId: "c" }, sql, config, {
      channel: () => ({ get, patch }),
      output,
    });
    expect(output.write).toHaveBeenLastCalledWith(value);
  });
  it("imports and activates character", async () => {
    const value = {
      schemaVersion: 1,
      characterId: "primary",
      version: 1,
      name: "P",
      language: "ja",
      systemPrompt: "x",
      failureMessages: ["f"],
    };
    const importDraft = vi.fn(async () => undefined);
    const activate = vi.fn(async () => undefined);
    const directory = await mkdtemp(join(tmpdir(), "admin-cli-"));
    const path = join(directory, "character.json");
    await writeFile(path, JSON.stringify(value));
    const output = out();
    const openedWith: unknown[] = [];
    const d = {
      open: async (filePath: string, flags: number) => {
        openedWith.push(flags);
        return fsOpen(filePath, flags);
      },
      character: () => ({ importDraft, activate }),
      now: () => at,
      output,
    } as never;
    await dispatchAdminCommand({ kind: "character.import", path, actor: "a" }, sql, config, d);
    await dispatchAdminCommand(
      { kind: "character.activate", characterId: "primary", version: 1, actor: "a" },
      sql,
      config,
      d,
    );
    expect(importDraft).toHaveBeenCalledWith(value, "a", at);
    expect(activate).toHaveBeenCalledWith("primary", 1, "a", at);
    expect(output.write).toHaveBeenNthCalledWith(1, { imported: "primary@1" });
    expect(output.write).toHaveBeenNthCalledWith(2, { activated: "primary@1" });
    expect(openedWith).toEqual([constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK]);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects unsafe and oversized character files without importing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "admin-cli-"));
    const character = vi.fn(async () => undefined);
    const regular = join(directory, "regular.json");
    const oversized = join(directory, "oversized.json");
    const link = join(directory, "link.json");
    await writeFile(regular, "[]");
    await writeFile(oversized, "x".repeat(64 * 1024 + 1));
    await symlink(regular, link);
    const d = { character: () => ({ importDraft: character }), output: out() } as never;
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: directory, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: regular, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: oversized, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: link, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    expect(character).not.toHaveBeenCalled();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects invalid UTF-8 and malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "admin-cli-"));
    const invalidUtf8 = join(directory, "invalid-utf8.json");
    const invalidJson = join(directory, "invalid-json.json");
    await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
    await writeFile(invalidJson, "{");
    const d = { character: () => ({ importDraft: vi.fn() }), output: out() } as never;
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: invalidUtf8, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: invalidJson, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await rm(directory, { recursive: true, force: true });
  });
  it("uses effect queue positional APIs", async () => {
    const inspect = vi.fn(async () => ({}));
    const reconcileUnknown = vi.fn(async () => undefined);
    const output = out();
    await dispatchAdminCommand({ kind: "effect.inspect", effectId: "e" }, sql, config, {
      effect: () => ({ inspect, reconcileUnknown }) as never,
      output,
    });
    await dispatchAdminCommand(
      { kind: "effect.reconcile", effectId: "e", state: "succeeded", externalResourceId: "x", actor: "a", reason: "r" },
      sql,
      config,
      { effect: () => ({ inspect, reconcileUnknown }) as never, now: () => at, output },
    );
    expect(inspect).toHaveBeenCalledWith("e");
    expect(reconcileUnknown).toHaveBeenCalledWith("e", "succeeded", "x", "a", "r", at);
    expect(output.write).toHaveBeenCalledWith({});
    expect(output.write).toHaveBeenLastCalledWith({ reconciled: "e", state: "succeeded" });
  });

  it("closes the database when dispatch fails", async () => {
    const end = vi.fn(async () => undefined);
    const createClient = vi.fn(() => ({ end }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await main(
      ["migration.status"],
      { DATABASE_URL: "postgres://db", MIGRATIONS_DIR: "migrations" },
      {
        createClient,
        migrationStatus: vi.fn(async () => {
          throw new Error("boom");
        }) as never,
      },
    );
    expect(end).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("reports success separately from a close failure after a successful dispatch", async () => {
    const end = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await main(
      ["migration", "status"],
      { DATABASE_URL: "postgres://db", MIGRATIONS_DIR: "migrations" },
      {
        createClient: () => ({ end }) as never,
        migrationStatus: vi.fn(async () => []) as never,
        output: out(),
      },
    );
    expect(error).toHaveBeenCalledWith("Admin command succeeded, but closing the database connection failed");
    expect(process.exitCode).toBe(1);
    error.mockRestore();
    process.exitCode = undefined;
  });

  it("does not expose dependency or close errors", async () => {
    const secret = "postgres://secret\nTOKEN";
    const end = vi.fn(async () => {
      throw new Error(secret);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await main(
      ["migration.status"],
      { DATABASE_URL: secret, MIGRATIONS_DIR: "migrations" },
      {
        createClient: () => ({ end }) as never,
        migrationStatus: vi.fn(async () => {
          throw new Error(secret);
        }) as never,
      },
    );
    expect(error).toHaveBeenCalledWith("Admin command failed");
    expect(error.mock.calls.flat().join(" ")).not.toContain(secret);
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(secret);
    expect(process.exitCode).toBe(1);
    error.mockRestore();
    stderr.mockRestore();
  });
});
