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
	defaultSubject,
	discordGuildNamespace,
	GUILD_ID_RE,
	HUA_SELF_SUBJECT,
	INTERNAL_NAMESPACE,
	namespaceKey,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
	resolveNamespaceFromAgentId,
	type MemoryNamespace,
} from "@vicissitude/shared/namespace";
