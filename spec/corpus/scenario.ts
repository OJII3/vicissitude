import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const messageEventSchema = z.object({
  kind: z.literal("message"),
  atMs: z.number().int().nonnegative(),
  id: z.string().min(1),
  channelId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  actorId: z.string().min(1),
  content: z.string().min(1),
  mentionsBot: z.boolean().default(false),
  replyToId: z.string().min(1).nullable().default(null),
});

const typingEventSchema = z.object({
  kind: z.literal("typing"),
  atMs: z.number().int().nonnegative(),
  channelId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  actorId: z.string().min(1),
});

const scenarioEventSchema = z.discriminatedUnion("kind", [messageEventSchema, typingEventSchema]);

/** 評価対象となるトリガーメッセージの宛先。明示的な宛先を持たない後続メッセージは直前のトリガーを引き継ぐ。 */
const addresseeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("character") }),
  z.object({ kind: z.literal("user"), actorId: z.string().min(1) }),
  z.object({ kind: z.literal("channel") }),
  z.object({ kind: z.literal("unknown") }),
]);

const labelSchema = z.object({
  addressee: addresseeSchema,
  expectedAction: z.enum(["reply", "silence", "defer"]),
  /** 正しい応答が踏まえているべきメッセージの ID。silence なら空。 */
  referencedMessageIds: z.array(z.string().min(1)),
  /** トリガーから応答までの許容最大待機時間。silence シナリオでは null。 */
  maxWaitMs: z.number().int().positive().nullable(),
  /** このシナリオで誤介入した場合の重大度。 */
  misinterventionSeverity: z.enum(["low", "medium", "high"]),
  notes: z.string().optional(),
});

export const conversationScenarioSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    guildId: z.string().min(1),
    events: z.array(scenarioEventSchema).min(1),
    label: labelSchema,
  })
  .superRefine((scenario, ctx) => {
    const messageIds = new Set<string>();
    let lastAtMs = -1;
    for (const [index, event] of scenario.events.entries()) {
      if (event.atMs < lastAtMs) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "atMs"],
          message: "events must be ordered by atMs",
        });
      }
      lastAtMs = event.atMs;
      if (event.kind !== "message") continue;
      if (messageIds.has(event.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: `duplicate message id: ${event.id}`,
        });
      }
      if (event.replyToId !== null && !messageIds.has(event.replyToId)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "replyToId"],
          message: `replyToId must reference an earlier message: ${event.replyToId}`,
        });
      }
      messageIds.add(event.id);
    }
    for (const id of scenario.label.referencedMessageIds) {
      if (!messageIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["label", "referencedMessageIds"],
          message: `referencedMessageIds references an unknown message: ${id}`,
        });
      }
    }
    if (scenario.label.expectedAction === "reply" && scenario.label.maxWaitMs === null) {
      ctx.addIssue({
        code: "custom",
        path: ["label", "maxWaitMs"],
        message: "reply scenarios must define maxWaitMs",
      });
    }
    if (scenario.label.expectedAction === "silence" && scenario.label.referencedMessageIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["label", "referencedMessageIds"],
        message: "silence scenarios must not reference messages",
      });
    }
  });

export type ConversationScenario = z.infer<typeof conversationScenarioSchema>;

export interface LoadedScenario {
  file: string;
  scenario: ConversationScenario;
}

export interface LoadScenarioOptions {
  /** シナリオ本文の {{character}} プレースホルダを置き換えるキャラクター名。 */
  characterName: string;
}

const CHARACTER_PLACEHOLDER = "{{character}}";

function substituteCharacter(scenario: ConversationScenario, characterName: string): ConversationScenario {
  const replace = (text: string) => text.replaceAll(CHARACTER_PLACEHOLDER, characterName);
  return {
    ...scenario,
    description: replace(scenario.description),
    events: scenario.events.map((event) =>
      event.kind === "message" ? { ...event, content: replace(event.content) } : event,
    ),
    label: {
      ...scenario.label,
      ...(scenario.label.notes === undefined ? {} : { notes: replace(scenario.label.notes) }),
    },
  };
}

export function loadScenarios(dir: string, options: LoadScenarioOptions): LoadedScenario[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const parsed = conversationScenarioSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.message}`);
    }
    return { file, scenario: substituteCharacter(parsed.data, options.characterName) };
  });
}
