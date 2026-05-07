import { z } from "zod";

/** NaN を拒否する整数バリデーション */
export const safeInt = z
	.number()
	.int()
	.refine((n) => !Number.isNaN(n), "must be a valid integer");
export const safeNumber = z.number().refine((n) => !Number.isNaN(n), "must be a valid number");

export const minecraftSchema = z.object({
	host: z.string(),
	port: safeInt,
	username: z.string(),
	version: z.string().optional(),
	authMode: z.enum(["offline", "microsoft"]),
	profilesFolder: z.string().optional(),
	mcpPort: safeInt,
	viewerPort: safeInt,
});

export const spotifySchema = z.object({
	clientId: z.string(),
	clientSecret: z.string(),
	refreshToken: z.string(),
	recommendPlaylistId: z.string().optional(),
});

export const geniusSchema = z.object({
	accessToken: z.string(),
});

export const ttsSchema = z.object({
	baseUrl: z.string(),
	speakerId: safeInt,
});

export const githubSchema = z.object({
	token: z.string(),
	owner: z.string(),
	repo: z.string(),
});

export const imageRecognitionSchema = z.object({
	enabled: z.boolean(),
	providerId: z.string().min(1, "DISCORD_IMAGE_RECOGNITION_PROVIDER_ID is required"),
	modelId: z.string().min(1, "DISCORD_IMAGE_RECOGNITION_MODEL_ID is required"),
});

export const shellWorkspaceNetworkProfileSchema = z.enum(["open", "none"]);

export const shellWorkspaceAgentSchema = z.object({
	providerId: z.string().min(1, "SHELL_WORKSPACE_AGENT_PROVIDER_ID is required"),
	modelId: z.string().min(1, "SHELL_WORKSPACE_AGENT_MODEL_ID is required"),
	temperature: safeNumber.min(0).max(2),
	steps: safeInt.min(1),
});

export const shellWorkspaceSchema = z
	.object({
		enabled: z.literal(true),
		image: z.string().min(1, "SHELL_WORKSPACE_IMAGE is required"),
		agent: shellWorkspaceAgentSchema,
		dataDir: z.string(),
		hostDataDir: z.string().optional(),
		auditLogPath: z.string(),
		networkProfile: shellWorkspaceNetworkProfileSchema,
		defaultTtlMinutes: safeInt.min(1),
		maxTtlMinutes: safeInt.min(1),
		defaultTimeoutSeconds: safeInt.min(1),
		maxTimeoutSeconds: safeInt.min(1),
		maxOutputChars: safeInt.min(1),
	})
	.refine((v) => v.defaultTtlMinutes <= v.maxTtlMinutes, {
		message: "SHELL_WORKSPACE_DEFAULT_TTL_MINUTES must be <= SHELL_WORKSPACE_MAX_TTL_MINUTES",
		path: ["defaultTtlMinutes"],
	})
	.refine((v) => v.defaultTimeoutSeconds <= v.maxTimeoutSeconds, {
		message:
			"SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS must be <= SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS",
		path: ["defaultTimeoutSeconds"],
	});

export const appConfigSchema = z.object({
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
	imageRecognition: imageRecognitionSchema.optional(),
	shellWorkspace: shellWorkspaceSchema.optional(),
	dataDir: z.string(),
	contextDir: z.string(),
});

export type SpotifyConfig = z.infer<typeof spotifySchema>;
export type GeniusConfig = z.infer<typeof geniusSchema>;
export type TtsConfig = z.infer<typeof ttsSchema>;
export type MinecraftConfig = z.infer<typeof minecraftSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
