import { readFileSync } from "fs";
import { resolve } from "path";

import { DISCORD_USER_ID_RE } from "@vicissitude/shared/namespace";
import { z } from "zod";

import {
	appConfigSchema,
	minecraftSchema,
	safeInt,
	safeNumber,
	shellWorkspaceEnvironmentSchema,
	shellWorkspaceGitSchema,
	shellWorkspaceNetworkProfileSchema,
	ttsSchema,
	type AppConfig,
} from "./config-schema.ts";

const modelSelectionSchema = z.strictObject({
	providerId: z.string().min(1),
	modelId: z.string().min(1),
});

const environmentSourceSchema = z.strictObject({
	fromEnv: z.string().min(1),
});

const shellWorkspaceProfileEnvironmentSchema = z.record(z.string().min(1), environmentSourceSchema);

const emotionEstimationProfileSchema = z
	.strictObject({
		providerId: z.string().min(1),
		modelId: z.string().min(1),
		ollamaBaseUrl: z.string().min(1).optional(),
	})
	.superRefine((value, ctx) => {
		if (value.providerId === "ollama" && !value.ollamaBaseUrl) {
			ctx.addIssue({
				code: "custom",
				path: ["ollamaBaseUrl"],
				message: "features.emotionEstimation.ollamaBaseUrl is required when providerId is ollama",
			});
		}
	});

const discordDmProfileSchema = z.strictObject({
	allowedUserIds: z
		.array(z.string().regex(DISCORD_USER_ID_RE, "Discord user ID must be numeric"))
		.min(1),
});

export const profileConfigSchema = z.strictObject({
	$schema: z.string().min(1).optional(),
	ports: z.strictObject({
		web: safeInt,
		gateway: safeInt,
		opencodeBase: safeInt,
	}),
	session: z.strictObject({
		maxAgeHours: safeNumber,
	}),
	models: z.strictObject({
		conversation: modelSelectionSchema.extend({
			temperature: safeNumber.min(0).max(2),
		}),
		heartbeat: modelSelectionSchema.extend({
			temperature: safeNumber.min(0).max(2),
		}),
		memory: modelSelectionSchema.extend({
			ollamaBaseUrl: z.string().min(1),
			embeddingModel: z.string().min(1),
		}),
		minecraft: modelSelectionSchema.extend({
			temperature: safeNumber.min(0).max(2),
		}),
	}),
	features: z.strictObject({
		discordDm: discordDmProfileSchema.optional(),
		imageRecognition: modelSelectionSchema.optional(),
		emotionEstimation: emotionEstimationProfileSchema.optional(),
		shellWorkspace: z
			.strictObject({
				image: z.string().min(1),
				agent: modelSelectionSchema.extend({
					temperature: safeNumber.min(0).max(2),
					steps: safeInt.min(1),
				}),
				environment: shellWorkspaceProfileEnvironmentSchema.optional(),
				git: shellWorkspaceGitSchema.optional(),
				backgroundSubagents: z.literal(true).optional(),
				hostDataDir: z.string().min(1).optional(),
				networkProfile: shellWorkspaceNetworkProfileSchema.optional(),
				defaultTtlMinutes: safeInt.min(1),
				maxTtlMinutes: safeInt.min(1),
				defaultTimeoutSeconds: safeInt.min(1),
				maxTimeoutSeconds: safeInt.min(1),
				maxOutputChars: safeInt.min(1),
			})
			.optional(),
		minecraft: minecraftSchema.optional(),
		tts: ttsSchema.optional(),
		githubIssues: z.strictObject({}).optional(),
	}),
});

export type ProfileConfig = z.infer<typeof profileConfigSchema>;

function buildProfileShellWorkspaceConfig(
	profile: ProfileConfig,
	env: Record<string, string | undefined>,
	dataDir: string,
): AppConfig["shellWorkspace"] {
	const shellWorkspace = profile.features.shellWorkspace;
	if (!shellWorkspace) return;
	return {
		enabled: true,
		image: shellWorkspace.image,
		agent: shellWorkspace.agent,
		environment: resolveShellWorkspaceEnvironment(shellWorkspace.environment, env),
		...(shellWorkspace.git ? { git: shellWorkspace.git } : {}),
		...(shellWorkspace.backgroundSubagents ? { backgroundSubagents: true as const } : {}),
		dataDir: resolve(dataDir, "shell-workspaces"),
		...(shellWorkspace.hostDataDir ? { hostDataDir: shellWorkspace.hostDataDir } : {}),
		auditLogPath: resolve(dataDir, "shell-workspace-audit.jsonl"),
		networkProfile: shellWorkspace.networkProfile ?? "open",
		defaultTtlMinutes: shellWorkspace.defaultTtlMinutes,
		maxTtlMinutes: shellWorkspace.maxTtlMinutes,
		defaultTimeoutSeconds: shellWorkspace.defaultTimeoutSeconds,
		maxTimeoutSeconds: shellWorkspace.maxTimeoutSeconds,
		maxOutputChars: shellWorkspace.maxOutputChars,
	};
}

function resolveShellWorkspaceEnvironment(
	sources: Record<string, { fromEnv: string }> | undefined,
	env: Record<string, string | undefined>,
): Record<string, string> | undefined {
	if (!sources) return;
	const resolved = Object.fromEntries(
		Object.entries(sources).map(([name, source]) => [
			name,
			requireSecret(env, source.fromEnv, `features.shellWorkspace.environment.${name}`),
		]),
	);
	return shellWorkspaceEnvironmentSchema.parse(resolved);
}

function requireSecret(
	env: Record<string, string | undefined>,
	name: string,
	featureName: string,
): string {
	const value = env[name];
	if (value && value.trim()) return value;
	throw new Error(`${name} is required when ${featureName} is configured`);
}

export function loadProfileConfigFile(filepath: string): ProfileConfig {
	const raw = JSON.parse(readFileSync(filepath, "utf8")) as unknown;
	return profileConfigSchema.parse(raw);
}

export function loadConfigFromProfile(
	profile: ProfileConfig,
	env: Record<string, string | undefined> = process.env,
	root?: string,
): AppConfig {
	const resolvedRoot = root ?? env.APP_ROOT ?? resolve(process.cwd());
	const dataDir = resolve(resolvedRoot, "data");

	const raw = {
		discordToken: requireSecret(env, "DISCORD_TOKEN", "discord"),
		webPort: profile.ports.web,
		gatewayPort: profile.ports.gateway,
		opencode: {
			providerId: profile.models.conversation.providerId,
			modelId: profile.models.conversation.modelId,
			basePort: profile.ports.opencodeBase,
			sessionMaxAgeHours: profile.session.maxAgeHours,
			temperature: profile.models.conversation.temperature,
		},
		heartbeatOpencode: {
			providerId: profile.models.heartbeat.providerId,
			modelId: profile.models.heartbeat.modelId,
			temperature: profile.models.heartbeat.temperature,
		},
		memory: {
			providerId: profile.models.memory.providerId,
			modelId: profile.models.memory.modelId,
			ollamaBaseUrl: profile.models.memory.ollamaBaseUrl,
			embeddingModel: profile.models.memory.embeddingModel,
		},
		mcBrain: {
			providerId: profile.models.minecraft.providerId,
			modelId: profile.models.minecraft.modelId,
			temperature: profile.models.minecraft.temperature,
		},
		tts: profile.features.tts,
		minecraft: profile.features.minecraft,
		github: profile.features.githubIssues
			? {
					token: requireSecret(env, "GITHUB_TOKEN", "features.githubIssues"),
					owner: requireSecret(env, "GITHUB_OWNER", "features.githubIssues"),
					repo: requireSecret(env, "GITHUB_REPO", "features.githubIssues"),
				}
			: undefined,
		discordDm: profile.features.discordDm
			? {
					allowedUserIds: profile.features.discordDm.allowedUserIds,
				}
			: undefined,
		imageRecognition: profile.features.imageRecognition
			? {
					enabled: true,
					providerId: profile.features.imageRecognition.providerId,
					modelId: profile.features.imageRecognition.modelId,
				}
			: undefined,
		emotionEstimation: profile.features.emotionEstimation
			? {
					enabled: true,
					providerId: profile.features.emotionEstimation.providerId,
					modelId: profile.features.emotionEstimation.modelId,
					ollamaBaseUrl: profile.features.emotionEstimation.ollamaBaseUrl,
				}
			: undefined,
		shellWorkspace: buildProfileShellWorkspaceConfig(profile, env, dataDir),
		dataDir,
		contextDir: resolve(resolvedRoot, "context"),
	};

	return appConfigSchema.parse(raw);
}
