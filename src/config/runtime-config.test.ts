import { describe, expect, it } from "vitest";
import { loadAdminConfig, loadGatewayConfig, loadWorkerConfig } from "./runtime-config.js";

const base = { DATABASE_URL: "postgres://user:pass@localhost/db" };

describe("runtime config", () => {
  it("loads gateway defaults and trimmed admin ids", () => {
    const config = loadGatewayConfig({
      ...base,
      DISCORD_TOKEN: " token ",
      VICISSITUDE_GUILD_ID: " guild ",
      VICISSITUDE_ADMIN_USER_IDS: " a, ,b ",
    });
    expect(config).toMatchObject({
      discordToken: "token",
      guildId: "guild",
      adminIds: ["a", "b"],
      healthPort: 8080,
      characterId: "primary",
      batch: { batchWindowMs: 8_000, maxWaitMs: 30_000 },
    });
  });
  it("reads batch parameters and rejects a max wait below the batch window", () => {
    const gateway = {
      ...base,
      DISCORD_TOKEN: "x",
      VICISSITUDE_GUILD_ID: "g",
      VICISSITUDE_ADMIN_USER_IDS: "a",
    };
    expect(
      loadGatewayConfig({ ...gateway, VICISSITUDE_BATCH_WINDOW_MS: "3000", VICISSITUDE_MAX_WAIT_MS: "12000" }).batch,
    ).toEqual({ batchWindowMs: 3_000, maxWaitMs: 12_000 });
    expect(() => loadGatewayConfig({ ...gateway, VICISSITUDE_MAX_WAIT_MS: "5000" })).toThrow(
      /VICISSITUDE_MAX_WAIT_MS/u,
    );
    expect(() => loadGatewayConfig({ ...gateway, VICISSITUDE_BATCH_WINDOW_MS: "0" })).toThrow();
  });
  it("requires gateway secrets and valid ports", () => {
    expect(() => loadGatewayConfig(base)).toThrow();
    expect(() =>
      loadGatewayConfig({
        ...base,
        DISCORD_TOKEN: "x",
        VICISSITUDE_GUILD_ID: "g",
        VICISSITUDE_ADMIN_USER_IDS: "a",
        VICISSITUDE_GATEWAY_HEALTH_PORT: "0",
      }),
    ).toThrow();
    expect(() =>
      loadGatewayConfig({
        ...base,
        DISCORD_TOKEN: "x",
        VICISSITUDE_GUILD_ID: "g",
        VICISSITUDE_ADMIN_USER_IDS: "a",
        VICISSITUDE_GATEWAY_HEALTH_PORT: "70000",
      }),
    ).toThrow();
  });
  it("loads worker without discord secrets", () => {
    expect(loadWorkerConfig(base)).toMatchObject({ workerId: "cognition-1", healthPort: 8081, characterId: "primary" });
  });
  it("requires database URL and rejects blank admin ids and bad protocols", () => {
    expect(() => loadAdminConfig({ ...base, VICISSITUDE_ADMIN_USER_IDS: " , " })).not.toThrow();
    expect(() =>
      loadGatewayConfig({ ...base, DISCORD_TOKEN: "x", VICISSITUDE_GUILD_ID: "g", VICISSITUDE_ADMIN_USER_IDS: " , " }),
    ).toThrow();
    expect(() => loadAdminConfig({ DATABASE_URL: "sqlite://db" })).toThrow();
  });
});
