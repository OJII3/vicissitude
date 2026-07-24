import { describe, expect, it, vi } from "vitest";
import { denyAllCapabilities } from "../../modules/channels/channel-capability.js";
import { FixedClock } from "../../shared/clock.js";
import { handleChannelCommand } from "./channel-command.js";

function interaction(input: Record<string, unknown> = {}) {
  const values = input as {
    userId?: string;
    guildId?: string | null;
    subcommand?: string;
    channel?: unknown;
    booleans?: Record<string, boolean | null>;
    reason?: string;
    events?: string[];
  };
  return {
    guildId: values.guildId === undefined ? "g" : values.guildId,
    user: { id: values.userId ?? "admin" },
    options: {
      getChannel: vi.fn(() => values.channel ?? { id: "thread", parentId: "parent", isThread: () => true }),
      getSubcommand: () => values.subcommand ?? "set",
      getBoolean: (name: string) => values.booleans?.[name] ?? null,
      getString: () => values.reason ?? " change ",
    },
    deferReply: vi.fn().mockImplementation(async () => values.events?.push("defer")),
    editReply: vi.fn().mockImplementation(async () => values.events?.push("edit")),
    reply: vi.fn().mockImplementation(async () => values.events?.push("reply")),
  } as never;
}

describe("handleChannelCommand", () => {
  it("does not read for DM or non-admin", async () => {
    const repo = { get: vi.fn(), set: vi.fn(), patch: vi.fn() };
    await handleChannelCommand(
      interaction({ guildId: null }),
      "g",
      new Set(["admin"]),
      repo,
      new FixedClock(new Date()),
    );
    await handleChannelCommand(
      interaction({ userId: "other" }),
      "g",
      new Set(["admin"]),
      repo,
      new FixedClock(new Date()),
    );
    expect(repo.get).not.toHaveBeenCalled();
    expect(repo.set).not.toHaveBeenCalled();
  });

  it("shows current parent capability and preserves omitted values", async () => {
    const current = { ...denyAllCapabilities("g", "parent"), spontaneousJoin: true };
    const repo = { get: vi.fn().mockResolvedValue(current), set: vi.fn(), patch: vi.fn() };
    await handleChannelCommand(
      interaction({ subcommand: "show" }),
      "g",
      new Set(["admin"]),
      repo,
      new FixedClock(new Date()),
    );
    expect(repo.get).toHaveBeenCalledWith("g", "parent");
  });

  it("updates every independent flag and rejects blank or orphan reasons/threads", async () => {
    const repo = { get: vi.fn(), set: vi.fn(), patch: vi.fn().mockResolvedValue(undefined) };
    await handleChannelCommand(
      interaction({
        channel: { id: "c", isThread: () => false },
        booleans: {
          observe: true,
          mentions: true,
          join: true,
          topics: true,
          reactions: true,
          threads: true,
          files: true,
          links: true,
        },
        reason: "reason",
      }),
      "g",
      new Set(["admin"]),
      repo,
      new FixedClock(new Date()),
    );
    expect(repo.get).not.toHaveBeenCalled();
    expect(repo.patch).toHaveBeenCalledWith(
      "g",
      "c",
      {
        observeEvents: true,
        respondToMentions: true,
        spontaneousJoin: true,
        spontaneousTopic: true,
        addReactions: true,
        createThreads: true,
        shareFiles: true,
        shareExternalLinks: true,
      },
      "admin",
      "reason",
      expect.any(Date),
    );
    await expect(
      handleChannelCommand(interaction({ reason: "  " }), "g", new Set(["admin"]), repo, new FixedClock(new Date())),
    ).rejects.toThrow("Reason is required");
    await expect(
      handleChannelCommand(
        interaction({ channel: { id: "orphan", parentId: null, isThread: () => true } }),
        "g",
        new Set(["admin"]),
        repo,
        new FixedClock(new Date()),
      ),
    ).rejects.toThrow("Thread has no parent channel");
  });

  it("rejects another guild before admin, options, or repository work", async () => {
    const events: string[] = [];
    const repo = { get: vi.fn(), set: vi.fn(), patch: vi.fn() };
    const value = interaction({ guildId: "other", events });
    await handleChannelCommand(value, "g", new Set(["admin"]), repo, new FixedClock(new Date()));
    expect(repo.get).not.toHaveBeenCalled();
    expect((value as { options: { getChannel: ReturnType<typeof vi.fn> } }).options.getChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["reply"]);
  });

  it("defers before delayed repository work and edits exactly once", async () => {
    const events: string[] = [];
    let resolve!: (value: ReturnType<typeof denyAllCapabilities>) => void;
    const repo = {
      get: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
      set: vi.fn(),
      patch: vi.fn(),
    };
    const value = interaction({ events, subcommand: "show" });
    const pending = handleChannelCommand(value, "g", new Set(["admin"]), repo, new FixedClock(new Date()));
    await vi.waitFor(() => expect(events).toEqual(["defer"]));
    resolve(denyAllCapabilities("g", "parent"));
    await pending;
    expect(events).toEqual(["defer", "edit"]);
    expect((value as { editReply: ReturnType<typeof vi.fn> }).editReply).toHaveBeenCalledTimes(1);
  });

  it("edits a generic error and rethrows without exposing the raw error", async () => {
    const events: string[] = [];
    const value = interaction({ events });
    const error = new Error("raw database secret");
    const repo = { get: vi.fn(), patch: vi.fn().mockRejectedValue(error) };
    await expect(handleChannelCommand(value, "g", new Set(["admin"]), repo, new FixedClock(new Date()))).rejects.toBe(
      error,
    );
    expect(events).toEqual(["defer", "edit"]);
    expect((value as { editReply: ReturnType<typeof vi.fn> }).editReply.mock.calls[0]?.[0].content).not.toContain(
      "raw database secret",
    );
  });
});
