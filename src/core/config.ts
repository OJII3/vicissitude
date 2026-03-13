import { resolve } from "path";

import { z } from "zod";

// ─── Constants ───────────────────────────────────────────────────

/** Heartbeat config JSON の相対パス（プロジェクトルート起点） */
export const HEARTBEAT_CONFIG_RELATIVE_PATH = "data/heartbeat-config.json";

// ─── Schemas ─────────────────────────────────────────────────────

/** NaN を拒否する整数バリデーション */
const safeInt = z
	.number()
	.int()
	.refine((n) => !Number.isNaN(n), "must be a valid integer");
const safeNumber = z.number().refine((n) => !Number.isNaN(n), "must be a valid number");

const minecraftSchema = z.object({
	host: z.string(),
	port: safeInt,
	username: z.string(),
	version: z.string().optional(),
	mcpPort: safeInt,
	viewerPort: safeInt,
});

const appConfigSchema = z.object({
	discordToken: z.string().min(1, "DISCORD_TOKEN is required"),
	opencode: z.object({
		providerId: z.string(),
		modelId: z.string(),
		basePort: safeInt,
		sessionMaxAgeHours: safeNumber,
	}),
	coreMcpPort: safeInt,
	ltm: z.object({
		providerId: z.string(),
		modelId: z.string(),
		ollamaBaseUrl: z.string(),
		embeddingModel: z.string(),
	}),
	mcBrain: z.object({
		providerId: z.string(),
		modelId: z.string(),
	}),
	minecraft: minecraftSchema.optional(),
	dataDir: z.string(),
	contextDir: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────

export type MinecraftConfig = z.infer<typeof minecraftSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

// ─── Loader ──────────────────────────────────────────────────────

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
	root?: string,
): AppConfig {
	const resolvedRoot = root ?? process.env.APP_ROOT ?? resolve(import.meta.dirname, "../..");

	const openCodeProviderId = env.OPENCODE_PROVIDER_ID ?? "github-copilot";

	const basePort = Number(env.OPENCODE_BASE_PORT ?? "4096");

	const raw = {
		discordToken: env.DISCORD_TOKEN ?? "",
		opencode: {
			providerId: openCodeProviderId,
			modelId: env.OPENCODE_MODEL_ID ?? "big-pickle",
			basePort,
			sessionMaxAgeHours: Number(env.SESSION_MAX_AGE_HOURS ?? "48"),
		},
		coreMcpPort: Number(env.CORE_MCP_PORT ?? String(basePort - 1)),
		ltm: {
			providerId: env.LTM_PROVIDER_ID ?? openCodeProviderId,
			modelId: env.LTM_MODEL_ID ?? "gpt-4o",
			ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://ollama:11434",
			embeddingModel: env.LTM_EMBEDDING_MODEL ?? "embeddinggemma",
		},
		mcBrain: {
			providerId: env.MC_PROVIDER_ID ?? openCodeProviderId,
			modelId: env.MC_MODEL_ID ?? env.OPENCODE_MODEL_ID ?? "big-pickle",
		},
		minecraft: env.MC_HOST
			? {
					host: env.MC_HOST,
					port: Number(env.MC_PORT ?? "25565"),
					username: env.MC_USERNAME ?? "hua",
					version: env.MC_VERSION,
					mcpPort: Number(env.MC_MCP_PORT ?? "3001"),
					viewerPort: Number(env.MC_VIEWER_PORT ?? "3007"),
				}
			: undefined,
		dataDir: resolve(resolvedRoot, "data"),
		contextDir: resolve(resolvedRoot, "context"),
	};

	return appConfigSchema.parse(raw);
}
