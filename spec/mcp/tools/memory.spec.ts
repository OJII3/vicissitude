/* oxlint-disable no-non-null-assertion -- test assertions after toBeDefined() checks */
import { describe, expect, test } from "bun:test";

import { discordGuildNamespace, INTERNAL_NAMESPACE } from "@vicissitude/memory/namespace";

import { captureMemoryTools } from "./memory-test-helpers";

describe("registerMemoryTools: boundNamespace による guild_id スキーマ省略契約", () => {
	const MEMORY_TOOLS = ["memory_retrieve", "memory_get_facts"] as const;

	describe("boundNamespace が INTERNAL_NAMESPACE の場合", () => {
		const { schemas } = captureMemoryTools(INTERNAL_NAMESPACE);

		for (const toolName of MEMORY_TOOLS) {
			test(`${toolName} の inputSchema に guild_id が含まれない`, () => {
				const schema = schemas.get(toolName)!;
				expect(schema).toBeDefined();
				expect("guild_id" in schema).toBe(false);
			});
		}
	});

	describe("boundNamespace が discordGuildNamespace の場合", () => {
		const { schemas } = captureMemoryTools(discordGuildNamespace("123"));

		for (const toolName of MEMORY_TOOLS) {
			test(`${toolName} の inputSchema に guild_id が含まれない`, () => {
				const schema = schemas.get(toolName)!;
				expect(schema).toBeDefined();
				expect("guild_id" in schema).toBe(false);
			});
		}
	});

	describe("boundNamespace が undefined の場合", () => {
		const { schemas } = captureMemoryTools();

		for (const toolName of MEMORY_TOOLS) {
			test(`${toolName} の inputSchema に guild_id が含まれる`, () => {
				const schema = schemas.get(toolName)!;
				expect(schema).toBeDefined();
				expect("guild_id" in schema).toBe(true);
			});
		}
	});
});
