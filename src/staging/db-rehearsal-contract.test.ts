import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("staging database rehearsal contract", () => {
  it("ships the rehearsal driver and assertion SQL", () => {
    for (const path of [
      "nix/db-rehearsal.sh",
      "nix/db-rehearsal.nix",
      "nix/sql/runtime-acl.sql",
      "nix/sql/fixture.sql",
      "nix/sql/privilege-matrix.sql",
      "nix/sql/catalog-assertions.sql",
    ]) expect(existsSync(resolve(root, path)), path).toBe(true);
  });

  it("declares isolated PostgreSQL 17 clusters and the exact success marker", () => {
    const script = read("nix/db-rehearsal.sh");
    expect(script).toContain("initdb");
    expect(script).toContain("--auth=trust");
    expect(script).toContain("unix_socket_directories");
    expect(script).toContain("@$encoded/vicissitude?port=");
    expect(script).toContain("staging-db-rehearsal: PASS");
    expect(script).toContain("pg_restore --create --exit-on-error");
  });

  it("connects the check to the x86_64-linux flake output", () => {
    const flake = read("flake.nix");
    expect(flake).toContain("staging-db-rehearsal");
    expect(read("nix/db-rehearsal.nix")).toContain("postgresql_17");
  });
});
