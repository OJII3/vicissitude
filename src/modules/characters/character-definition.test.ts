import { describe, expect, test } from "vitest";
import { CharacterDefinitionSchema } from "./character-definition.js";

describe("CharacterDefinition", () => {
  test("parses a Japanese definition and fallback messages", () => {
    const value = CharacterDefinitionSchema.parse({
      schemaVersion: 1,
      characterId: "haru_1",
      version: 1,
      name: " 春 ",
      language: "ja",
      systemPrompt: "  丁寧に答える  ",
      failureMessages: [" 失敗しました "],
    });
    expect(value.name).toBe("春");
    expect(value.systemPrompt).toBe("丁寧に答える");
    expect(value.failureMessages).toEqual(["失敗しました"]);
  });
  test("rejects empty fallback and invalid ids", () => {
    expect(() =>
      CharacterDefinitionSchema.parse({
        schemaVersion: 1,
        characterId: "Bad",
        version: 1,
        name: "x",
        language: "ja",
        systemPrompt: "x",
        failureMessages: [" "],
      }),
    ).toThrow();
  });
});
