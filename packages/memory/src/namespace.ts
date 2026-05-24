/**
 * MemoryNamespace — re-export from @vicissitude/shared/namespace.
 *
 * The canonical definition lives in shared so that any package depending only
 * on shared (application, scheduling, etc.) can still construct namespaces.
 * This module re-exports those identifiers so that memory-package consumers
 * can import namespace APIs alongside other memory symbols.
 *
 * See packages/shared/src/namespace.ts for full documentation.
 */

export {
	AGENT_SCOPE_ID_RE,
	agentScopeNamespace,
	defaultSubject,
	DISCORD_GUILD_ID_RE,
	DISCORD_USER_ID_RE,
	discordDmScopeId,
	discordDmUserIdFromScopeId,
	discordGuildIdFromScopeId,
	discordScopeId,
	discoverNamespacesFromDisk,
	GUILD_ID_RE,
	HUA_SELF_SUBJECT,
	INTERNAL_NAMESPACE,
	migrateLegacyGuildMemoryNamespaces,
	namespaceKey,
	parseAgentId,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
	resolveNamespaceFromAgentId,
	type DiscordAgentRole,
	type MemoryNamespace,
	type ParsedAgentId,
} from "@vicissitude/shared/namespace";
