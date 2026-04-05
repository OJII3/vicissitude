/**
 * MemoryNamespace — re-export from @vicissitude/shared/namespace.
 *
 * The canonical definition lives in shared so that any package depending only
 * on shared (application, scheduling, etc.) can still construct namespaces.
 * This module exists for backward compatibility with existing imports and for
 * spec tests that import from `@vicissitude/memory/namespace`.
 *
 * See packages/shared/src/namespace.ts for full documentation.
 */

export {
	defaultSubject,
	discordGuildNamespace,
	HUA_SELF_SUBJECT,
	INTERNAL_NAMESPACE,
	namespaceKey,
	parseNamespaceKey,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
	resolveNamespaceFromAgentId,
	type MemoryNamespace,
} from "@vicissitude/shared/namespace";
