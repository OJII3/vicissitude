import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface BareDeployProfile {
	models?: {
		memory?: {
			ollamaBaseUrl?: string;
			embeddingModel?: string;
		};
	};
	features?: {
		emotionEstimation?: {
			providerId?: string;
			ollamaBaseUrl?: string;
		};
	};
	[key: string]: unknown;
}

export function rewriteProfileForBareDeploy(
	profile: BareDeployProfile,
	ollamaBaseUrl: string,
): BareDeployProfile {
	return {
		...profile,
		models: {
			...profile.models,
			memory: {
				...profile.models?.memory,
				ollamaBaseUrl,
			},
		},
		features: profile.features?.emotionEstimation
			? {
					...profile.features,
					emotionEstimation:
						profile.features.emotionEstimation.providerId === "ollama"
							? {
									...profile.features.emotionEstimation,
									ollamaBaseUrl,
								}
							: profile.features.emotionEstimation,
				}
			: profile.features,
	};
}

export function prepareBareConfig(
	inputPath: string,
	outputPath: string,
	ollamaBaseUrl: string,
): void {
	const input = JSON.parse(readFileSync(inputPath, "utf8")) as BareDeployProfile;
	const rewritten = rewriteProfileForBareDeploy(input, ollamaBaseUrl);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, `${JSON.stringify(rewritten, null, "\t")}\n`);
}

export function parseArgs(argv: string[]): {
	inputPath: string;
	outputPath: string;
	ollamaBaseUrl: string;
} {
	let inputPath: string | undefined;
	let outputPath: string | undefined;
	let ollamaBaseUrl = "http://127.0.0.1:11434";

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = argv[index + 1];
		if ((arg === "--input" || arg === "-i") && value) {
			inputPath = value;
			index += 1;
			continue;
		}
		if ((arg === "--output" || arg === "-o") && value) {
			outputPath = value;
			index += 1;
			continue;
		}
		if (arg === "--ollama-base-url" && value) {
			ollamaBaseUrl = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown or incomplete argument: ${arg}`);
	}

	if (!inputPath) throw new Error("--input is required");
	if (!outputPath) throw new Error("--output is required");

	return {
		inputPath: resolve(inputPath),
		outputPath: resolve(outputPath),
		ollamaBaseUrl,
	};
}

if (import.meta.main) {
	try {
		const { inputPath, outputPath, ollamaBaseUrl } = parseArgs(process.argv.slice(2));
		prepareBareConfig(inputPath, outputPath, ollamaBaseUrl);
		console.log(
			`[bare-config] wrote ${outputPath} from ${inputPath} (ollamaBaseUrl=${ollamaBaseUrl})`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[bare-config] failed: ${message}`);
		process.exit(1);
	}
}
