import type { EventEmitter } from "node:events";

export interface ShutdownEmitter {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
export function shutdownSignal(emitter: ShutdownEmitter = process as unknown as EventEmitter): Promise<AbortSignal> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const onSignal = () => {
      emitter.off("SIGINT", onSignal);
      emitter.off("SIGTERM", onSignal);
      controller.abort();
      resolve(controller.signal);
    };
    emitter.once("SIGINT", onSignal);
    emitter.once("SIGTERM", onSignal);
  });
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new RangeError("sleep duration must be non-negative"));
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
