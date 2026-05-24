import { DISCORD_USER_ID_RE } from "@vicissitude/shared/namespace";
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

export const ttsSchema = z.object({
	baseUrl: z.string(),
	speakerId: safeInt,
});

export const githubSchema = z.object({
	token: z.string(),
	owner: z.string(),
	repo: z.string(),
});

export const discordDmSchema = z.object({
	allowedUserIds: z
		.array(z.string().regex(DISCORD_USER_ID_RE, "Discord user ID must be numeric"))
		.min(1, "discordDm.allowedUserIds must contain at least one user ID"),
});

export const imageRecognitionSchema = z.object({
	enabled: z.boolean(),
	providerId: z.string().min(1, "imageRecognition.providerId is required"),
	modelId: z.string().min(1, "imageRecognition.modelId is required"),
});

export const emotionEstimationSchema = z
	.object({
		enabled: z.literal(true),
		providerId: z.string().min(1, "emotionEstimation.providerId is required"),
		modelId: z.string().min(1, "emotionEstimation.modelId is required"),
		ollamaBaseUrl: z.string().min(1, "emotionEstimation.ollamaBaseUrl is required").optional(),
	})
	.superRefine((value, ctx) => {
		if (value.providerId === "ollama" && !value.ollamaBaseUrl) {
			ctx.addIssue({
				code: "custom",
				path: ["ollamaBaseUrl"],
				message: "emotionEstimation.ollamaBaseUrl is required when providerId is ollama",
			});
		}
	});

export const shellWorkspaceNetworkProfileSchema = z.enum(["open", "none"]);

export const shellWorkspaceAgentSchema = z.object({
	providerId: z.string().min(1, "shellWorkspace.agent.providerId is required"),
	modelId: z.string().min(1, "shellWorkspace.agent.modelId is required"),
	temperature: safeNumber.min(0).max(2),
	steps: safeInt.min(1),
});

export const shellWorkspaceEnvironmentSchema = z.record(z.string().min(1), z.string().min(1));

export const shellWorkspaceSchema = z
	.object({
		enabled: z.literal(true),
		image: z.string().min(1, "shellWorkspace.image is required"),
		agent: shellWorkspaceAgentSchema,
		environment: shellWorkspaceEnvironmentSchema.optional(),
		backgroundSubagents: z.literal(true).optional(),
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
		message: "shellWorkspace.defaultTtlMinutes must be <= shellWorkspace.maxTtlMinutes",
		path: ["defaultTtlMinutes"],
	})
	.refine((v) => v.defaultTimeoutSeconds <= v.maxTimeoutSeconds, {
		message: "shellWorkspace.defaultTimeoutSeconds must be <= shellWorkspace.maxTimeoutSeconds",
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
	heartbeatOpencode: z.object({
		providerId: z.string(),
		modelId: z.string(),
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
	tts: ttsSchema.optional(),
	minecraft: minecraftSchema.optional(),
	github: githubSchema.optional(),
	discordDm: discordDmSchema.optional(),
	imageRecognition: imageRecognitionSchema.optional(),
	emotionEstimation: emotionEstimationSchema.optional(),
	shellWorkspace: shellWorkspaceSchema.optional(),
	dataDir: z.string(),
	contextDir: z.string(),
});

export type TtsConfig = z.infer<typeof ttsSchema>;
export type MinecraftConfig = z.infer<typeof minecraftSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
