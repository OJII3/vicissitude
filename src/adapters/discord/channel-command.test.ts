import { describe, expect, it, vi } from "vitest";
import { denyAllCapabilities } from "../../modules/channels/channel-capability.js";
import { FixedClock } from "../../shared/clock.js";
import { channelCommand, handleChannelCommand } from "./channel-command.js";

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
  it("places required subcommand options before optional options", () => {
    const command = channelCommand.toJSON();
    const setSubcommand = command.options?.find((option) => option.name === "set");
    if (!setSubcommand || !("options" in setSubcommand)) throw new Error("set subcommand options are missing");
    const options = setSubcommand.options as Array<{ name: string; required?: boolean }>;
    expect(options.map((option) => [option.name, option.required])).toEqual([
      ["channel", true],
      ["reason", true],
      ["observe", false],
      ["mentions", false],
      ["join", false],
      ["topics", false],
      ["reactions", false],
      ["threads", false],
      ["files", false],
      ["links", false],
    ]);
  });

  it("does not read for DM or non-admin", async () => {
    const repo = { get: vi.fn(), set: vi.fn(), patch: vi.fn(), getThread: vi.fn(), patchThread: vi.fn() };
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
    const repo = {
      get: vi.fn().mockResolvedValue(current),
      set: vi.fn(),
      patch: vi.fn(),
      getThread: vi.fn(),
      patchThread: vi.fn(),
    };
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
    const repo = {
      get: vi.fn(),
      set: vi.fn(),
      patch: vi.fn().mockResolvedValue(undefined),
      getThread: vi.fn(),
      patchThread: vi.fn(),
    };
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
    const repo = { get: vi.fn(), set: vi.fn(), patch: vi.fn(), getThread: vi.fn(), patchThread: vi.fn() };
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
      getThread: vi.fn(),
      patchThread: vi.fn(),
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
    const repo = { get: vi.fn(), patch: vi.fn().mockRejectedValue(error), getThread: vi.fn(), patchThread: vi.fn() };
    await expect(handleChannelCommand(value, "g", new Set(["admin"]), repo, new FixedClock(new Date()))).rejects.toBe(
      error,
    );
    expect(events).toEqual(["defer", "edit"]);
    expect((value as { editReply: ReturnType<typeof vi.fn> }).editReply.mock.calls[0]?.[0].content).not.toContain(
      "raw database secret",
    );
  });
});

function interactionFor(subcommand: string, options: Record<string, string | boolean | null>, channel: unknown) {
  return {
    guildId: "guild-1",
    user: { id: "admin-1" },
    options: {
      getSubcommand: () => subcommand,
      getChannel: () => channel,
      getString: (name: string, required?: boolean) => {
        const value = options[name];
        if (typeof value === "string") return value;
        if (required) throw new Error(`missing ${name}`);
        return null;
      },
      getBoolean: (name: string) => {
        const value = options[name];
        return typeof value === "boolean" ? value : null;
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as never;
}

const thread = { id: "thread-1", parentId: "channel-1", isThread: () => true };
const clock = { now: () => new Date("2026-01-02T03:04:05.000Z") };

describe("handleChannelCommand thread subcommands", () => {
  it("translates allow, deny and inherit into an override patch", async () => {
    const repository = {
      get: vi.fn(),
      patch: vi.fn().mockResolvedValue(undefined),
      getThread: vi.fn().mockResolvedValue(null),
      patchThread: vi.fn().mockResolvedValue(undefined),
    };
    const interaction = interactionFor(
      "thread-set",
      { observe: "allow", mentions: "deny", reactions: "inherit", reason: "tune thread" },
      thread,
    );

    await handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock);

    expect(repository.patchThread).toHaveBeenCalledWith(
      "guild-1",
      "channel-1",
      "thread-1",
      { observeEvents: true, respondToMentions: false, addReactions: null },
      "admin-1",
      "tune thread",
      clock.now(),
    );
  });

  it("omits capabilities that were not supplied", async () => {
    const repository = {
      get: vi.fn(),
      patch: vi.fn(),
      getThread: vi.fn().mockResolvedValue(null),
      patchThread: vi.fn().mockResolvedValue(undefined),
    };
    const interaction = interactionFor("thread-set", { observe: "deny", reason: "quiet" }, thread);

    await handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock);

    expect(repository.patchThread).toHaveBeenCalledWith(
      "guild-1",
      "channel-1",
      "thread-1",
      { observeEvents: false },
      "admin-1",
      "quiet",
      clock.now(),
    );
  });

  it("passes an empty patch through when reason is supplied but no capability is set", async () => {
    const repository = {
      get: vi.fn(),
      patch: vi.fn(),
      getThread: vi.fn().mockResolvedValue(null),
      patchThread: vi.fn().mockResolvedValue(undefined),
    };
    const interaction = interactionFor("thread-set", { reason: "no-op audit" }, thread);

    await handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock);

    expect(repository.patchThread).toHaveBeenCalledWith(
      "guild-1",
      "channel-1",
      "thread-1",
      {},
      "admin-1",
      "no-op audit",
      clock.now(),
    );
  });

  it("rejects a thread subcommand on a non-thread channel", async () => {
    const repository = { get: vi.fn(), patch: vi.fn(), getThread: vi.fn(), patchThread: vi.fn() };
    const channel = { id: "channel-1", parentId: null, isThread: () => false };
    const interaction = interactionFor("thread-set", { observe: "allow", reason: "nope" }, channel);

    await expect(handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock)).rejects.toThrow(
      "Thread subcommands require a thread channel",
    );
    expect(repository.patchThread).not.toHaveBeenCalled();
  });

  it("rejects a thread subcommand on an orphaned thread with a distinct message", async () => {
    const repository = { get: vi.fn(), patch: vi.fn(), getThread: vi.fn(), patchThread: vi.fn() };
    const orphan = { id: "thread-1", parentId: null, isThread: () => true };
    const interaction = interactionFor("thread-set", { observe: "allow", reason: "nope" }, orphan);

    await expect(handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock)).rejects.toThrow(
      "Thread has no parent channel",
    );
    expect(repository.patchThread).not.toHaveBeenCalled();
  });

  it("rejects an unsupported override value", async () => {
    const repository = { get: vi.fn(), patch: vi.fn(), getThread: vi.fn(), patchThread: vi.fn() };
    const interaction = interactionFor("thread-set", { observe: "maybe", reason: "typo" }, thread);

    await expect(handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock)).rejects.toThrow(
      "Unsupported override value: maybe",
    );
    expect(repository.patchThread).not.toHaveBeenCalled();
  });

  it("shows the current override for a thread", async () => {
    const repository = {
      get: vi.fn(),
      patch: vi.fn(),
      getThread: vi.fn().mockResolvedValue({
        guildId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-1",
        observeEvents: true,
        respondToMentions: null,
        addReactions: null,
      }),
      patchThread: vi.fn(),
    };
    const interaction = interactionFor("thread-show", {}, thread);

    await handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock);

    expect(repository.getThread).toHaveBeenCalledWith("guild-1", "channel-1", "thread-1");
    expect((interaction as { editReply: ReturnType<typeof vi.fn> }).editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("observeEvents") }),
    );
  });
});
