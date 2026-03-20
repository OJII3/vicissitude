import { resolve } from "path";

import { z } from "zod";

// ─── Constants ───────────────────────────────────────────────────

/** プロジェクトルートパス（環境変数 or cwd） */
export const APP_ROOT = process.env.APP_ROOT ?? resolve(process.cwd());

/** Heartbeat config JSON の相対パス（プロジェクトルート起点） */
export const HEARTBEAT_CONFIG_RELATIVE_PATH = "data/heartbeat-config.json";

// ─── Schemas ─────────────────────────────────────────────────────

/** NaN を拒否する整数バリデーション */
const safeInt = z
	.number()
	.int()
	.refine((n) => !Number.isNaN(n), "must be a valid integer");
const safeNumber = z.number().refine((n) => !Number.isNaN(n), "must be a valid number");

const mcAuthModeSchema = z.enum(["offline", "microsoft"]);
export type McAuthMode = z.infer<typeof mcAuthModeSchema>;

export function parseMcAuthMode(value: string): McAuthMode {
	const result = mcAuthModeSchema.safeParse(value);
	if (!result.success) {
		throw new Error('MC_AUTH_MODE must be "offline" or "microsoft"');
	}
	return result.data;
}

const minecraftSchema = z.object({
	host: z.string(),
	port: safeInt,
	username: z.string(),
	version: z.string().optional(),
	authMode: mcAuthModeSchema,
	profilesFolder: z.string().optional(),
	mcpPort: safeInt,
	viewerPort: safeInt,
});

const ttsSchema = z.object({
	baseUrl: z.string(),
	speakerId: safeInt,
});

const appConfigSchema = z.object({
	discordToken: z.string().min(1, "DISCORD_TOKEN is required"),
	webPort: safeInt,
	gatewayPort: safeInt,
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
	tts: ttsSchema.optional(),
	minecraft: minecraftSchema.optional(),
	dataDir: z.string(),
	contextDir: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────

export type TtsConfig = z.infer<typeof ttsSchema>;
export type MinecraftConfig = z.infer<typeof minecraftSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

// ─── Loader ──────────────────────────────────────────────────────

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
	root?: string,
): AppConfig {
	const resolvedRoot = root ?? process.env.APP_ROOT ?? resolve(process.cwd());

	const openCodeProviderId = env.OPENCODE_PROVIDER_ID ?? "github-copilot";

	const basePort = Number(env.OPENCODE_BASE_PORT ?? "4096");

	const raw = {
		discordToken: env.DISCORD_TOKEN ?? "",
		webPort: Number(env.WEB_PORT ?? "4000"),
		gatewayPort: Number(env.GATEWAY_PORT ?? "4001"),
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
		tts: env.AIVIS_SPEECH_URL
			? {
					baseUrl: env.AIVIS_SPEECH_URL,
					speakerId: Number(env.AIVIS_SPEECH_SPEAKER_ID ?? "0"),
				}
			: undefined,
		minecraft: env.MC_HOST
			? {
					host: env.MC_HOST,
					port: Number(env.MC_PORT ?? "25565"),
					username: env.MC_USERNAME ?? "hua",
					version: env.MC_VERSION,
					authMode: env.MC_AUTH_MODE ?? "offline",
					profilesFolder: env.MC_PROFILES_FOLDER,
					mcpPort: Number(env.MC_MCP_PORT ?? "3001"),
					viewerPort: Number(env.MC_VIEWER_PORT ?? "3007"),
				}
			: undefined,
		dataDir: resolve(resolvedRoot, "data"),
		contextDir: resolve(resolvedRoot, "context"),
	};

	return appConfigSchema.parse(raw);
}
