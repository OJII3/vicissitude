import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	parseArgs,
	prepareBareConfig,
	rewriteProfileForBareDeploy,
} from "./prepare-bare-config.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("prepare-bare-config", () => {
	test("memory.ollamaBaseUrl を bare deploy 向けに差し替える", () => {
		const rewritten = rewriteProfileForBareDeploy(
			{
				models: {
					memory: {
						ollamaBaseUrl: "http://ollama:11434",
						embeddingModel: "embeddinggemma",
					},
				},
			},
			"http://127.0.0.1:11434",
		);

		expect(rewritten.models?.memory?.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
		expect(rewritten.models?.memory?.embeddingModel).toBe("embeddinggemma");
	});

	test("emotionEstimation が ollama のときだけ ollamaBaseUrl を差し替える", () => {
		const rewritten = rewriteProfileForBareDeploy(
			{
				models: { memory: { ollamaBaseUrl: "http://ollama:11434" } },
				features: {
					emotionEstimation: {
						providerId: "ollama",
						ollamaBaseUrl: "http://emotion-ollama:11434",
					},
				},
			},
			"http://127.0.0.1:11434",
		);

		expect(rewritten.features?.emotionEstimation?.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
	});

	test("prepareBareConfig はファイルを生成する", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vicissitude-bare-config-"));
		const inputPath = join(tempDir, "input.json");
		const outputPath = join(tempDir, "nested", "output.json");
		writeFileSync(
			inputPath,
			JSON.stringify({
				models: {
					memory: {
						ollamaBaseUrl: "http://ollama:11434",
						embeddingModel: "embeddinggemma",
					},
				},
			}),
		);

		prepareBareConfig(inputPath, outputPath, "http://127.0.0.1:11434");

		const output = JSON.parse(readFileSync(outputPath, "utf8")) as {
			models: { memory: { ollamaBaseUrl: string } };
		};
		expect(output.models.memory.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
	});

	test("parseArgs は required option を解釈する", () => {
		const parsed = parseArgs([
			"--input",
			"config/default.json",
			"--output",
			"/tmp/output.json",
			"--ollama-base-url",
			"http://127.0.0.1:11434",
		]);

		expect(parsed.inputPath.endsWith("/config/default.json")).toBe(true);
		expect(parsed.outputPath).toBe("/tmp/output.json");
		expect(parsed.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
	});
});
