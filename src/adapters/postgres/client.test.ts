import { describe, expect, it } from "vitest";
import { createPostgresClient } from "./client.js";

describe("PostgreSQL Unix socket URL boundary", () => {
  it("configures postgres.js with the decoded socket and port", async () => {
    const sql = createPostgresClient(
      "postgresql://role:secret@%2Ftmp%2Fvicissitude%2Fsocket/db?port=55432&sslmode=require",
    );

    expect(sql.options.host).toEqual(["/tmp/vicissitude/socket"]);
    expect(sql.options.port).toEqual([55432]);
    expect(sql.options.database).toBe("db");
    expect(sql.options.user).toBe("role");
    expect(sql.options.ssl).toBe("require");

    await sql.end();
  });

  it("accepts lowercase percent encoding for a socket authority", async () => {
    const sql = createPostgresClient("postgresql://role@%2ftmp%2fvicissitude%2fsocket/db");

    expect(sql.options.host).toEqual(["/tmp/vicissitude/socket"]);

    await sql.end();
  });
});
