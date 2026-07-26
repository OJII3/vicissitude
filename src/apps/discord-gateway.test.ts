import { describe, expect, it, vi } from "vitest";
import { cleanupGateway, handleGatewayFatal, registerGatewayListeners, startGatewayClient } from "./discord-gateway.js";

describe("gateway startup helpers", () => {
  it("registers listeners before login and commands after login", async () => {
    const order: string[] = [];
    const client = {
      on: vi.fn((event: string) => {
        order.push(`listener:${event}`);
      }),
      login: vi.fn(async () => {
        order.push("login");
      }),
      guilds: {
        fetch: vi.fn(async () => ({
          commands: {
            set: vi.fn(async () => {
              order.push("commands");
            }),
          },
        })),
      },
    };
    registerGatewayListeners(client as never, { messageCreate: () => undefined, interactionCreate: () => undefined });
    await startGatewayClient(client as never, "token", "guild", {});
    expect(order.slice(0, 2)).toEqual(["listener:messageCreate", "listener:interactionCreate"]);
    expect(order).toContain("login");
    expect(order.at(-1)).toBe("commands");
  });
  it("cleans up in order even when release fails", async () => {
    const order: string[] = [];
    const destroy = vi.fn(async () => {
      order.push("destroy");
    });
    await expect(
      cleanupGateway({
        stop: () => {
          order.push("stop");
        },
        destroy,
        drain: async () => {
          order.push("drain");
        },
        release: async () => {
          order.push("release");
          throw new Error("release");
        },
        end: async () => {
          order.push("end");
        },
      }),
    ).rejects.toThrow("Gateway cleanup failed");
    expect(order).toEqual(["stop", "destroy", "drain", "release", "end"]);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("keeps fatal handling free of fire-and-forget destroy", async () => {
    const fatal = vi.fn();
    const accepting = { value: true };
    const health = { setReady: vi.fn() };
    handleGatewayFatal(accepting, health, fatal, new Error("ingestion"));
    expect(accepting.value).toBe(false);
    expect(health.setReady).toHaveBeenCalledWith(false);
    expect(fatal).toHaveBeenCalledOnce();
  });
});
