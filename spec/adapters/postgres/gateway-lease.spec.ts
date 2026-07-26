import { describe, expect, it } from "vitest";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { acquireGatewayLease } from "../../../src/adapters/postgres/gateway-lease.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("gateway advisory lease", () => {
  it("serializes gateway recovery ownership across reserved connections", async () => {
    const firstSql = createPostgresClient(url!);
    const secondSql = createPostgresClient(url!);
    const first = await acquireGatewayLease(firstSql);
    await expect(acquireGatewayLease(secondSql)).rejects.toThrow("already running");
    await first.release();
    const third = await acquireGatewayLease(secondSql);
    await third.release();
    await firstSql.end({ timeout: 1 });
    await secondSql.end({ timeout: 1 });
  });
});
