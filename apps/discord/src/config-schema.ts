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

export const emailCheckSchema = z.object({
	endpoint: z.string().min(1, "GAS_EMAIL_ENDPOINT is required"),
	token: z.string().min(1, "GAS_EMAIL_TOKEN is required"),
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

export const shellAgentAgentSchema = z.object({
	providerId: z.string().min(1, "shellAgent.agent.providerId is required"),
	modelId: z.string().min(1, "shellAgent.agent.modelId is required"),
});

export const shellAgentEnvironmentSchema = z.record(z.string().min(1), z.string().min(1));

export const shellAgentGitSchema = z.object({
	userName: z
		.string()
		.min(1, "shellAgent.git.userName is required")
		.refine(isSingleLineGitConfigValue, "shellAgent.git.userName is invalid"),
	userEmail: z
		.email("shellAgent.git.userEmail must be an email address")
		.refine(isSingleLineGitConfigValue, "shellAgent.git.userEmail is invalid"),
});

function isSingleLineGitConfigValue(value: string): boolean {
	return !value.includes("\0") && !value.includes("\r") && !value.includes("\n");
}

export const shellAgentSchema = z.object({
	enabled: z.literal(true),
	agent: shellAgentAgentSchema,
	environment: shellAgentEnvironmentSchema.optional(),
	git: shellAgentGitSchema.optional(),
	backgroundSubagents: z.literal(true).optional(),
	dataDir: z.string(),
});

export const appConfigSchema = z
	.object({
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
		mcBrain: z
			.object({
				providerId: z.string(),
				modelId: z.string(),
				temperature: safeNumber.min(0).max(2),
			})
			.optional(),
		tts: ttsSchema.optional(),
		minecraft: minecraftSchema.optional(),
		github: githubSchema.optional(),
		emailCheck: emailCheckSchema.optional(),
		discordDm: discordDmSchema.optional(),
		imageRecognition: imageRecognitionSchema.optional(),
		emotionEstimation: emotionEstimationSchema.optional(),
		shellAgent: shellAgentSchema.optional(),
		dataDir: z.string(),
		contextDir: z.string(),
	})
	.refine((config) => Boolean(config.minecraft) === Boolean(config.mcBrain), {
		message: "minecraft and mcBrain must both be configured or both be absent",
		path: ["minecraft"],
	});

export type TtsConfig = z.infer<typeof ttsSchema>;
export type MinecraftConfig = z.infer<typeof minecraftSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
