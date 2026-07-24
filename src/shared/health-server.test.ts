import { describe, expect, it } from "vitest";
import { createHealthServer } from "./health-server.js";

describe("health server", () => {
  it("serves live and readiness with JSON status", async () => {
    const health = createHealthServer();
    const server = await health.listen(0);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    expect((await fetch(`${base}/live`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    expect((await fetch(`${base}/unknown`)).status).toBe(404);
    expect((await fetch(`${base}/live`, { method: "POST" })).status).toBe(405);
    await health.close();
  });
});
