import { z } from "zod";

const trimmed = (max: number) => z.string().trim().min(1).max(max);
export const CharacterDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  characterId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  version: z.number().int().positive(),
  name: trimmed(100),
  language: z.literal("ja"),
  systemPrompt: trimmed(20000),
  failureMessages: z.array(trimmed(600)).min(1).max(10),
});
export type CharacterDefinition = z.infer<typeof CharacterDefinitionSchema>;
export interface CharacterDefinitionRepository {
  importDraft(definition: CharacterDefinition, actor: string, now: Date): Promise<void>;
  activate(characterId: string, version: number, actor: string, now: Date): Promise<void>;
  getProduction(characterId: string): Promise<CharacterDefinition | null>;
}
