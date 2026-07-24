import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { sleep, shutdownSignal } from "./process-lifecycle.js";

describe("process lifecycle", () => {
  it("aborts from one signal and cleans listeners", async () => {
    const emitter = new EventEmitter();
    const result = shutdownSignal(emitter);
    expect(emitter.listenerCount("SIGINT")).toBe(1);
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    emitter.emit("SIGTERM");
    const signal = await result;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
    emitter.emit("SIGINT");
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });

  it("uses the real Node process without installing test leaks", async () => {
    const before = process.listenerCount("SIGINT");
    const result = shutdownSignal();
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    process.emit("SIGINT");
    const signal = await result;
    expect(signal.aborted).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it("rejects invalid sleep duration", async () => {
    await expect(sleep(-1)).rejects.toThrow();
  });
  it("resolves normally when aborted", async () => {
    const controller = new AbortController();
    const pending = sleep(1000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
