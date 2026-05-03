import { resolve } from "path";

import { z } from "zod";

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
	authMode: z.enum(["offline", "microsoft"]),
	profilesFolder: z.string().optional(),
	mcpPort: safeInt,
	viewerPort: safeInt,
});

const spotifySchema = z.object({
	clientId: z.string(),
	clientSecret: z.string(),
	refreshToken: z.string(),
	recommendPlaylistId: z.string().optional(),
});

const geniusSchema = z.object({
	accessToken: z.string(),
});

const ttsSchema = z.object({
	baseUrl: z.string(),
	speakerId: safeInt,
});

const githubSchema = z.object({
	token: z.string(),
	owner: z.string(),
	repo: z.string(),
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
		temperature: safeNumber.min(0).max(2),
	}),
	memory: z.object({
		providerId: z.string(),
		modelId: z.string(),
		ollamaBaseUrl: z.string(),
		embeddingModel: z.string(),
	}),
	mcBrain: z.object({
		providerId: z.string(),
		modelId: z.string(),
		temperature: safeNumber.min(0).max(2),
	}),
	spotify: spotifySchema.optional(),
	genius: geniusSchema.optional(),
	tts: ttsSchema.optional(),
	minecraft: minecraftSchema.optional(),
	github: githubSchema.optional(),
	dataDir: z.string(),
	contextDir: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────

export type SpotifyConfig = z.infer<typeof spotifySchema>;
export type GeniusConfig = z.infer<typeof geniusSchema>;
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
			temperature: Number(env.OPENCODE_TEMPERATURE ?? "1.0"),
		},
		memory: {
			providerId: env.MEMORY_PROVIDER_ID ?? openCodeProviderId,
			modelId: env.MEMORY_MODEL_ID ?? "gpt-4o",
			ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://ollama:11434",
			embeddingModel: env.MEMORY_EMBEDDING_MODEL ?? "embeddinggemma",
		},
		mcBrain: {
			providerId: env.MC_PROVIDER_ID ?? openCodeProviderId,
			modelId: env.MC_MODEL_ID ?? env.OPENCODE_MODEL_ID ?? "big-pickle",
			temperature: Number(env.MC_TEMPERATURE ?? "0.7"),
		},
		spotify: env.SPOTIFY_CLIENT_ID
			? {
					clientId: env.SPOTIFY_CLIENT_ID,
					clientSecret: env.SPOTIFY_CLIENT_SECRET ?? "",
					refreshToken: env.SPOTIFY_REFRESH_TOKEN ?? "",
					recommendPlaylistId: env.SPOTIFY_RECOMMEND_PLAYLIST_ID,
				}
			: undefined,
		genius: env.GENIUS_ACCESS_TOKEN ? { accessToken: env.GENIUS_ACCESS_TOKEN } : undefined,
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
		github: env.GITHUB_TOKEN
			? {
					token: env.GITHUB_TOKEN,
					owner: env.GITHUB_OWNER ?? "",
					repo: env.GITHUB_REPO ?? "",
				}
			: undefined,
		dataDir: resolve(resolvedRoot, "data"),
		contextDir: resolve(resolvedRoot, "context"),
	};

	return appConfigSchema.parse(raw);
}
