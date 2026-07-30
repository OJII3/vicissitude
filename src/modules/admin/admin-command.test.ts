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
    [["thread", "show", "g", "c", "t"], { kind: "thread.show", guildId: "g", channelId: "c", threadId: "t" }],
    [
      [
        "thread",
        "set",
        "g",
        "c",
        "t",
        "--observe",
        "allow",
        "--mentions",
        "deny",
        "--reactions",
        "inherit",
        "--actor",
        ACTOR,
        "--reason",
        "r",
      ],
      {
        kind: "thread.set",
        guildId: "g",
        channelId: "c",
        threadId: "t",
        observeEvents: true,
        respondToMentions: false,
        addReactions: null,
        actor: ACTOR,
        reason: "r",
      },
    ],
    [
      ["thread", "set", "g", "c", "t", "--observe", "allow", "--actor", ACTOR, "--reason", "r"],
      {
        kind: "thread.set",
        guildId: "g",
        channelId: "c",
        threadId: "t",
        observeEvents: true,
        actor: ACTOR,
        reason: "r",
      },
    ],
    [
      ["thread", "set", "g", "c", "t", "--actor", ACTOR, "--reason", "r"],
      { kind: "thread.set", guildId: "g", channelId: "c", threadId: "t", actor: ACTOR, reason: "r" },
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

  it("omits unset thread override fields entirely rather than setting them to undefined", () => {
    const command = parseAdminCommand([
      "thread",
      "set",
      "g",
      "c",
      "t",
      "--observe",
      "allow",
      "--actor",
      ACTOR,
      "--reason",
      "r",
    ]);
    expect(command).toHaveProperty("observeEvents", true);
    expect(command).not.toHaveProperty("respondToMentions");
    expect(command).not.toHaveProperty("addReactions");
    expect(Object.keys(command)).not.toContain("observe");
    expect(Object.keys(command)).not.toContain("mentions");
    expect(Object.keys(command)).not.toContain("reactions");
  });

  it("omits all thread override fields when no capability option is supplied", () => {
    const command = parseAdminCommand(["thread", "set", "g", "c", "t", "--actor", ACTOR, "--reason", "r"]);
    expect(command).not.toHaveProperty("observeEvents");
    expect(command).not.toHaveProperty("respondToMentions");
    expect(command).not.toHaveProperty("addReactions");
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
    ["thread show missing positional", ["thread", "show", "g", "c"]],
    ["thread show extra positional", ["thread", "show", "g", "c", "t", "x"]],
    [
      "bad thread override value",
      ["thread", "set", "g", "c", "t", "--observe", "yes", "--actor", ACTOR, "--reason", "r"],
    ],
    ["thread set missing actor", ["thread", "set", "g", "c", "t", "--observe", "allow", "--reason", "r"]],
    ["thread set missing reason", ["thread", "set", "g", "c", "t", "--observe", "allow", "--actor", ACTOR]],
    [
      "thread set invalid actor",
      ["thread", "set", "g", "c", "t", "--observe", "allow", "--actor", "not-an-id", "--reason", "r"],
    ],
    [
      "thread set old option",
      ["thread", "set", "g", "c", "t", "--observed", "allow", "--actor", ACTOR, "--reason", "r"],
    ],
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
    [
      "thread observe",
      ["thread", "set", "g", "c", "t", "--observe", "allow", "--observe", "deny", "--actor", ACTOR, "--reason", "r"],
    ],
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
