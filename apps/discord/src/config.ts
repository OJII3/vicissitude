import { resolve } from "path";

import {
	appConfigSchema,
	type AppConfig,
	type GeniusConfig,
	type MinecraftConfig,
	type SpotifyConfig,
	type TtsConfig,
} from "./config-schema.ts";
import { loadConfigFromProfile, loadProfileConfigFile } from "./profile-config.ts";

export type { AppConfig, GeniusConfig, MinecraftConfig, SpotifyConfig, TtsConfig };

// ─── Loader ──────────────────────────────────────────────────────

function parseBooleanEnv(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function buildShellWorkspaceConfig(env: Record<string, string | undefined>, dataDir: string) {
	if (!parseBooleanEnv(env.SHELL_WORKSPACE_ENABLED)) return;
	return {
		enabled: true,
		image: env.SHELL_WORKSPACE_IMAGE ?? "vicissitude-code-exec",
		dataDir: resolve(dataDir, "shell-workspaces"),
		...(env.SHELL_WORKSPACE_HOST_DATA_DIR
			? { hostDataDir: env.SHELL_WORKSPACE_HOST_DATA_DIR }
			: {}),
		auditLogPath: resolve(dataDir, "shell-workspace-audit.jsonl"),
		networkProfile: env.SHELL_WORKSPACE_NETWORK_PROFILE ?? "open",
		defaultTtlMinutes: Number(env.SHELL_WORKSPACE_DEFAULT_TTL_MINUTES ?? "60"),
		maxTtlMinutes: Number(env.SHELL_WORKSPACE_MAX_TTL_MINUTES ?? "120"),
		defaultTimeoutSeconds: Number(env.SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS ?? "30"),
		maxTimeoutSeconds: Number(env.SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS ?? "120"),
		maxOutputChars: Number(env.SHELL_WORKSPACE_MAX_OUTPUT_CHARS ?? "50000"),
	};
}

export { loadConfigFromProfile, loadProfileConfigFile };

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
	root?: string,
): AppConfig {
	if (env.VICISSITUDE_CONFIG_PATH) {
		return loadConfigFromProfile(loadProfileConfigFile(env.VICISSITUDE_CONFIG_PATH), env, root);
	}
	return loadConfigFromEnv(env, root);
}

function loadConfigFromEnv(
	env: Record<string, string | undefined>,
	root: string | undefined,
): AppConfig {
	const resolvedRoot = root ?? env.APP_ROOT ?? resolve(process.cwd());
	const dataDir = resolve(resolvedRoot, "data");

	const openCodeProviderId = env.OPENCODE_PROVIDER_ID ?? "github-copilot";

	const basePort = Number(env.OPENCODE_BASE_PORT ?? "4096");
	const imageRecognitionEnabled = parseBooleanEnv(env.DISCORD_IMAGE_RECOGNITION_ENABLED);

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
		imageRecognition: imageRecognitionEnabled
			? {
					enabled: true,
					providerId: env.DISCORD_IMAGE_RECOGNITION_PROVIDER_ID ?? openCodeProviderId,
					modelId: env.DISCORD_IMAGE_RECOGNITION_MODEL_ID ?? "",
				}
			: undefined,
		shellWorkspace: buildShellWorkspaceConfig(env, dataDir),
		dataDir,
		contextDir: resolve(resolvedRoot, "context"),
	};

	return appConfigSchema.parse(raw);
}
