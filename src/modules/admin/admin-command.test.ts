import { describe, expect, it } from "vitest";
import { parseAdminCommand } from "./admin-command.js";

const ACTOR = "883258849254072341";

describe("admin parser exact union", () => {
  it.each([
    [["migration", "status"], { kind: "migration.status" }],
    [
      ["migration", "apply", "--backup-confirmed-at", "2026-07-24T00:00:00Z", "--actor", ACTOR],
      { kind: "migration.apply", backupConfirmedAt: new Date("2026-07-24T00:00:00Z"), actor: ACTOR },
    ],
    [
      ["system", "resume", "--actor", ACTOR, "--reason", "r"],
      { kind: "system.set", mode: "running", actor: ACTOR, reason: "r" },
    ],
    [
      ["system", "drain", "--actor", ACTOR, "--reason", "r"],
      { kind: "system.set", mode: "draining", actor: ACTOR, reason: "r" },
    ],
    [
      ["system", "stop", "--actor", ACTOR, "--reason", "r"],
      { kind: "system.set", mode: "stopped", actor: ACTOR, reason: "r" },
    ],
    [["channel", "show", "g", "c"], { kind: "channel.show", guildId: "g", channelId: "c" }],
    [
      ["channel", "set", "g", "c", "--observe", "true", "--mentions", "false", "--actor", ACTOR, "--reason", "r"],
      {
        kind: "channel.set",
        guildId: "g",
        channelId: "c",
        observeEvents: true,
        respondToMentions: false,
        actor: ACTOR,
        reason: "r",
      },
    ],
    [["character", "import", "x", "--actor", ACTOR], { kind: "character.import", path: "x", actor: ACTOR }],
    [
      ["character", "activate", "id", "2", "--actor", ACTOR],
      { kind: "character.activate", characterId: "id", version: 2, actor: ACTOR },
    ],
    [["effect", "inspect", "e"], { kind: "effect.inspect", effectId: "e" }],
    [
      [
        "effect",
        "reconcile",
        "e",
        "--state",
        "succeeded",
        "--external-resource-id",
        "x",
        "--actor",
        ACTOR,
        "--reason",
        "r",
      ],
      {
        kind: "effect.reconcile",
        effectId: "e",
        state: "succeeded",
        externalResourceId: "x",
        actor: ACTOR,
        reason: "r",
      },
    ],
    [
      ["effect", "reconcile", "e", "--state", "failed", "--actor", ACTOR, "--reason", "r"],
      { kind: "effect.reconcile", effectId: "e", state: "failed", externalResourceId: null, actor: ACTOR, reason: "r" },
    ],
  ] as const)("parses %j exactly", (args, expected) => expect(parseAdminCommand([...args])).toEqual(expected));

  it("keeps every contract field name compile-time and runtime fixed", () => {
    const command = parseAdminCommand([
      "channel",
      "set",
      "g",
      "c",
      "--observe",
      "true",
      "--mentions",
      "false",
      "--actor",
      ACTOR,
      "--reason",
      "r",
    ]);
    expect(command).toHaveProperty("observeEvents");
    expect(command).toHaveProperty("respondToMentions");
    expect(command).not.toHaveProperty("observe");
    expect(command).not.toHaveProperty("mentions");
  });

  it.each([
    ["missing", []],
    ["unknown action", ["system", "set"]],
    ["old action", ["system", "set", "--mode", "running", "--actor", ACTOR, "--reason", "r"]],
    ["old option", ["channel", "set", "--guild-id", "g"]],
    ["extra positional", ["channel", "show", "g", "c", "x"]],
    ["blank value", ["channel", "show", " ", "c"]],
    [
      "bad bool",
      ["channel", "set", "g", "c", "--observe", "yes", "--mentions", "false", "--actor", ACTOR, "--reason", "r"],
    ],
    ["bad date", ["migration", "apply", "--backup-confirmed-at", "x", "--actor", ACTOR]],
    ["bad version", ["character", "activate", "id", "0", "--actor", ACTOR]],
    [
      "failed external id",
      [
        "effect",
        "reconcile",
        "e",
        "--state",
        "failed",
        "--external-resource-id",
        "x",
        "--actor",
        ACTOR,
        "--reason",
        "r",
      ],
    ],
    ["missing external id", ["effect", "reconcile", "e", "--state", "succeeded", "--actor", ACTOR, "--reason", "r"]],
    ["unknown option", ["migration", "status", "--old", "x"]],
  ] as const)("rejects %s", (_, args) => expect(() => parseAdminCommand([...args])).toThrow());

  it.each(["admin-id", "883258849254072341x", "8832588492540", "883258849254072341883258849254072341", " "])(
    "rejects actor %j that is not a Discord user ID",
    (value) => {
      expect(() => parseAdminCommand(["system", "drain", "--actor", value, "--reason", "r"])).toThrow();
    },
  );

  it.each([
    ["--help", "c"],
    ["--guild-id", "c"],
  ])("rejects option-like channel show token %s", (token, channelId) => {
    expect(() => parseAdminCommand(["channel", "show", token, channelId])).toThrow();
  });

  it.each([
    [
      "actor",
      ["migration", "apply", "--backup-confirmed-at", "2026-07-24T00:00:00Z", "--actor", ACTOR, "--actor", "b"],
    ],
    [
      "actor equals",
      ["migration", "apply", "--backup-confirmed-at=2026-07-24T00:00:00Z", `--actor=${ACTOR}`, "--actor=b"],
    ],
    [
      "backup",
      [
        "migration",
        "apply",
        "--backup-confirmed-at",
        "2026-07-24T00:00:00Z",
        "--backup-confirmed-at",
        "2026-07-24T01:00:00Z",
        "--actor",
        ACTOR,
      ],
    ],
    [
      "state",
      ["effect", "reconcile", "e", "--state", "failed", "--state", "succeeded", "--actor", ACTOR, "--reason", "r"],
    ],
    ["reason", ["system", "stop", "--actor", ACTOR, "--reason", "r1", "--reason", "r2"]],
  ] as const)("rejects duplicate %s", (_, args) => expect(() => parseAdminCommand([...args])).toThrow());

  it.each([
    ["2026-07-24T00:00:00Z", new Date("2026-07-24T00:00:00Z")],
    ["2026-07-24T09:00:00+09:00", new Date("2026-07-24T00:00:00Z")],
  ])("accepts ISO datetime %s", (value, expected) => {
    expect(parseAdminCommand(["migration", "apply", "--backup-confirmed-at", value, "--actor", ACTOR])).toEqual({
      kind: "migration.apply",
      backupConfirmedAt: expected,
      actor: ACTOR,
    });
  });

  it.each(["2026-07-24", "2026-07-24T00:00:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "not-a-date"])(
    "rejects non-valid ISO datetime %s without echoing input",
    (value) => {
      try {
        parseAdminCommand(["migration", "apply", "--backup-confirmed-at", value, "--actor", ACTOR]);
        throw new Error("expected parser to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(value);
      }
    },
  );
});
