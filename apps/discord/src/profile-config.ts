import { readFileSync } from "fs";
import { resolve } from "path";

import { z } from "zod";

import {
	appConfigSchema,
	minecraftSchema,
	safeInt,
	safeNumber,
	ttsSchema,
	type AppConfig,
} from "./config-schema.ts";

const modelSelectionSchema = z.strictObject({
	providerId: z.string().min(1),
	modelId: z.string().min(1),
});

export const profileConfigSchema = z.strictObject({
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
		memory: modelSelectionSchema.extend({
			ollamaBaseUrl: z.string().min(1),
			embeddingModel: z.string().min(1),
		}),
		minecraft: modelSelectionSchema.extend({
			temperature: safeNumber.min(0).max(2),
		}),
	}),
	features: z.strictObject({
		imageRecognition: modelSelectionSchema.optional(),
		shellWorkspace: z
			.strictObject({
				image: z.string().min(1),
				defaultTtlMinutes: safeInt.min(1),
				maxTtlMinutes: safeInt.min(1),
				defaultTimeoutSeconds: safeInt.min(1),
				maxTimeoutSeconds: safeInt.min(1),
				maxOutputChars: safeInt.min(1),
			})
			.optional(),
		minecraft: minecraftSchema.optional(),
		tts: ttsSchema.optional(),
		spotify: z.strictObject({}).optional(),
		genius: z.strictObject({}).optional(),
		githubIssues: z.strictObject({}).optional(),
	}),
});

export type ProfileConfig = z.infer<typeof profileConfigSchema>;

function buildProfileShellWorkspaceConfig(
	profile: ProfileConfig,
	dataDir: string,
): AppConfig["shellWorkspace"] {
	const shellWorkspace = profile.features.shellWorkspace;
	if (!shellWorkspace) return;
	return {
		enabled: true,
		image: shellWorkspace.image,
		dataDir: resolve(dataDir, "shell-workspaces"),
		auditLogPath: resolve(dataDir, "shell-workspace-audit.jsonl"),
		defaultTtlMinutes: shellWorkspace.defaultTtlMinutes,
		maxTtlMinutes: shellWorkspace.maxTtlMinutes,
		defaultTimeoutSeconds: shellWorkspace.defaultTimeoutSeconds,
		maxTimeoutSeconds: shellWorkspace.maxTimeoutSeconds,
		maxOutputChars: shellWorkspace.maxOutputChars,
	};
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
		spotify: profile.features.spotify
			? {
					clientId: requireSecret(env, "SPOTIFY_CLIENT_ID", "features.spotify"),
					clientSecret: requireSecret(env, "SPOTIFY_CLIENT_SECRET", "features.spotify"),
					refreshToken: requireSecret(env, "SPOTIFY_REFRESH_TOKEN", "features.spotify"),
				}
			: undefined,
		genius: profile.features.genius
			? { accessToken: requireSecret(env, "GENIUS_ACCESS_TOKEN", "features.genius") }
			: undefined,
		tts: profile.features.tts,
		minecraft: profile.features.minecraft,
		github: profile.features.githubIssues
			? {
					token: requireSecret(env, "GITHUB_TOKEN", "features.githubIssues"),
					owner: requireSecret(env, "GITHUB_OWNER", "features.githubIssues"),
					repo: requireSecret(env, "GITHUB_REPO", "features.githubIssues"),
				}
			: undefined,
		imageRecognition: profile.features.imageRecognition
			? {
					enabled: true,
					providerId: profile.features.imageRecognition.providerId,
					modelId: profile.features.imageRecognition.modelId,
				}
			: undefined,
		shellWorkspace: buildProfileShellWorkspaceConfig(profile, dataDir),
		dataDir,
		contextDir: resolve(resolvedRoot, "context"),
	};

	return appConfigSchema.parse(raw);
}
