import { describe, expect, it } from "vitest";

describe("PostgreSQL Unix socket URL boundary", () => {
  it("recognizes a percent-encoded socket authority as a socket path", () => {
    const url = new URL("postgresql://role@%2Ftmp%2Fvicissitude%2Fsocket/db");
    expect(decodeURIComponent(url.hostname)).toBe("/tmp/vicissitude/socket");
  });
});
