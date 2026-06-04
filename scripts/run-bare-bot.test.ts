import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildBareRuntimeEnv,
	parseOllamaHost,
	readMemoryEmbeddingModel,
	resolveBareRuntimeOptions,
} from "./run-bare-bot.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("run-bare-bot", () => {
	test("parseOllamaHost は base URL から host:port を取り出す", () => {
		expect(parseOllamaHost("http://127.0.0.1:11434")).toBe("127.0.0.1:11434");
	});

	test("resolveBareRuntimeOptions は XDG default と bare config path を解決する", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vicissitude-bare-runtime-"));
		const options = resolveBareRuntimeOptions({
			HOME: tempDir,
			APP_ROOT: "/repo/vicissitude",
		});

		expect(options.appRoot).toBe("/repo/vicissitude");
		expect(options.xdgConfigHome).toBe(join(tempDir, ".config"));
		expect(options.xdgDataHome).toBe(join(tempDir, ".local", "share"));
		expect(options.sourceConfigPath).toBe("/repo/vicissitude/config/default.json");
		expect(options.configPath).toBe(join(tempDir, ".config", "vicissitude", "config.json"));
		expect(options.ollamaHost).toBe("127.0.0.1:11434");
	});

	test("buildBareRuntimeEnv は bot 起動に必要な env を埋める", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vicissitude-bare-env-"));
		const options = resolveBareRuntimeOptions({
			HOME: tempDir,
			APP_ROOT: "/repo/vicissitude",
		});
		const runtimeEnv = buildBareRuntimeEnv({ HOME: tempDir }, options);

		expect(runtimeEnv.APP_ROOT).toBe("/repo/vicissitude");
		expect(runtimeEnv.VICISSITUDE_CONFIG_PATH).toBe(
			join(tempDir, ".config", "vicissitude", "config.json"),
		);
		expect(runtimeEnv.OLLAMA_HOST).toBe("127.0.0.1:11434");
	});

	test("readMemoryEmbeddingModel は generated config から model を読む", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vicissitude-bare-model-"));
		const configPath = join(tempDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				models: {
					memory: {
						embeddingModel: "embeddinggemma",
					},
				},
			}),
		);

		expect(readMemoryEmbeddingModel(configPath)).toBe("embeddinggemma");
		expect(JSON.parse(readFileSync(configPath, "utf8")).models.memory.embeddingModel).toBe(
			"embeddinggemma",
		);
	});
});
