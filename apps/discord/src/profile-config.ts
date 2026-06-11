import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import { DISCORD_USER_ID_RE } from "@vicissitude/shared/namespace";
import { z } from "zod";

import {
	appConfigSchema,
	minecraftSchema,
	safeInt,
	safeNumber,
	shellAgentEnvironmentSchema,
	shellAgentGitSchema,
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

const shellAgentProfileEnvironmentSchema = z.record(z.string().min(1), environmentSourceSchema);

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

export const profileConfigSchema = z
	.strictObject({
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
			minecraft: modelSelectionSchema
				.extend({
					temperature: safeNumber.min(0).max(2),
				})
				.optional(),
		}),
		features: z.strictObject({
			discordDm: discordDmProfileSchema.optional(),
			imageRecognition: modelSelectionSchema.optional(),
			emotionEstimation: emotionEstimationProfileSchema.optional(),
			shellAgent: z
				.strictObject({
					agent: modelSelectionSchema,
					environment: shellAgentProfileEnvironmentSchema.optional(),
					git: shellAgentGitSchema.optional(),
					backgroundSubagents: z.literal(true).optional(),
				})
				.optional(),
			minecraft: minecraftSchema.optional(),
			tts: ttsSchema.optional(),
			githubIssues: z.strictObject({}).optional(),
			emailCheck: z.strictObject({}).optional(),
		}),
	})
	.superRefine((profile, ctx) => {
		if (Boolean(profile.models.minecraft) === Boolean(profile.features.minecraft)) return;
		ctx.addIssue({
			code: "custom",
			message: "models.minecraft and features.minecraft must be configured together",
		});
	});

export type ProfileConfig = z.infer<typeof profileConfigSchema>;

const runtimeContextOverlaySchema = z.strictObject({
	discordDm: discordDmProfileSchema.optional(),
});

export type RuntimeContextOverlay = z.infer<typeof runtimeContextOverlaySchema>;

function buildProfileShellAgentConfig(
	profile: ProfileConfig,
	env: Record<string, string | undefined>,
	dataDir: string,
): AppConfig["shellAgent"] {
	const shellAgent = profile.features.shellAgent;
	if (!shellAgent) return;
	return {
		enabled: true,
		agent: shellAgent.agent,
		environment: resolveShellAgentEnvironment(shellAgent.environment, env),
		...(shellAgent.git ? { git: shellAgent.git } : {}),
		...(shellAgent.backgroundSubagents ? { backgroundSubagents: true as const } : {}),
		dataDir: resolve(dataDir, "shell-workspaces"),
	};
}

function resolveShellAgentEnvironment(
	sources: Record<string, { fromEnv: string }> | undefined,
	env: Record<string, string | undefined>,
): Record<string, string> | undefined {
	if (!sources) return;
	const resolved = Object.fromEntries(
		Object.entries(sources).map(([name, source]) => [
			name,
			requireSecret(env, source.fromEnv, `features.shellAgent.environment.${name}`),
		]),
	);
	return shellAgentEnvironmentSchema.parse(resolved);
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

function buildEmailCheckConfig(
	profile: ProfileConfig,
	env: Record<string, string | undefined>,
): AppConfig["emailCheck"] {
	if (!profile.features.emailCheck) return undefined;
	return {
		endpoint: requireSecret(env, "GAS_EMAIL_ENDPOINT", "features.emailCheck"),
		token: requireSecret(env, "GAS_EMAIL_TOKEN", "features.emailCheck"),
	};
}

export function loadProfileConfigFile(filepath: string): ProfileConfig {
	const raw = JSON.parse(readFileSync(filepath, "utf8")) as unknown;
	return profileConfigSchema.parse(raw);
}

export function loadRuntimeContextOverlay(root: string): RuntimeContextOverlay | undefined {
	const filepath = resolve(root, "data/context/runtime.json");
	if (!existsSync(filepath)) return;
	const raw = JSON.parse(readFileSync(filepath, "utf8")) as unknown;
	return runtimeContextOverlaySchema.parse(raw);
}

export function loadConfigFromProfile(
	profile: ProfileConfig,
	env: Record<string, string | undefined> = process.env,
	root?: string,
): AppConfig {
	const resolvedRoot = root ?? env.APP_ROOT ?? resolve(process.cwd());
	const dataDir = resolve(resolvedRoot, "data");
	const runtimeOverlay = loadRuntimeContextOverlay(resolvedRoot);

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
		mcBrain: profile.models.minecraft
			? {
					providerId: profile.models.minecraft.providerId,
					modelId: profile.models.minecraft.modelId,
					temperature: profile.models.minecraft.temperature,
				}
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
		emailCheck: buildEmailCheckConfig(profile, env),
		discordDm:
			(runtimeOverlay?.discordDm ?? profile.features.discordDm)
				? {
						allowedUserIds:
							runtimeOverlay?.discordDm?.allowedUserIds ??
							profile.features.discordDm?.allowedUserIds ??
							[],
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
		shellAgent: buildProfileShellAgentConfig(profile, env, dataDir),
		dataDir,
		contextDir: resolve(resolvedRoot, "context"),
	};

	return appConfigSchema.parse(raw);
}
