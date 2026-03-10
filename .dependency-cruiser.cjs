/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "core-isolation",
			comment: "core/ は src/ 内の他モジュールに依存してはいけない",
			severity: "error",
			from: { path: "^src/core/" },
			to: {
				path: "^src/(?!core/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "store-isolation",
			comment: "store/ は core/ 以外の src/ モジュールに依存してはいけない",
			severity: "error",
			from: { path: "^src/store/" },
			to: {
				path: "^src/(?!store/|core/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "observability-isolation",
			comment: "observability/ は core/ 以外の src/ モジュールに依存してはいけない",
			severity: "error",
			from: { path: "^src/observability/" },
			to: {
				path: "^src/(?!observability/|core/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "ollama-no-internal-deps",
			comment: "ollama/ は src/ 内の他モジュールに一切依存してはいけない",
			severity: "error",
			from: { path: "^src/ollama/" },
			to: {
				path: "^src/(?!ollama/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "opencode-isolation",
			comment: "opencode/ は core/ 以外の src/ モジュールに依存してはいけない",
			severity: "error",
			from: { path: "^src/opencode/" },
			to: {
				path: "^src/(?!opencode/|core/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "gateway-allowed-deps",
			comment:
				"gateway/ は core/, store/, scheduling/ 以外の src/ モジュールに依存してはいけない（scheduler.ts は scheduling/ への後方互換 re-export）",
			severity: "error",
			from: { path: "^src/gateway/" },
			to: {
				path: "^src/(?!gateway/|core/|store/|scheduling/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "fenghuang-allowed-deps",
			comment: "fenghuang/ は core/, ollama/ 以外の src/ モジュールに依存してはいけない",
			severity: "error",
			from: { path: "^src/fenghuang/" },
			to: {
				path: "^src/(?!fenghuang/|core/|ollama/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "scheduling-allowed-deps",
			comment: "scheduling/ は core/, observability/ 以外の src/ モジュールに依存してはいけない",
			severity: "error",
			from: { path: "^src/scheduling/" },
			to: {
				path: "^src/(?!scheduling/|core/|observability/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "agent-allowed-deps",
			comment: "agent/ は core/, store/ 以外の src/ モジュールに依存してはいけない",
			severity: "error",
			from: { path: "^src/agent/" },
			to: {
				path: "^src/(?!agent/|core/|store/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "mcp-allowed-deps",
			comment:
				"mcp/ は core/, store/, observability/, gateway/ 以外の src/ モジュールに依存してはいけない。エントリポイント（*-server.ts）は DI ルートのため除外",
			severity: "error",
			from: {
				path: "^src/mcp/",
				pathNot: "^src/mcp/(?:core-server|code-exec-server|mc-sub-server)\\.ts$",
			},
			to: {
				path: "^src/(?!mcp/|core/|store/|observability/|gateway/)",
				pathNot: "^src/(bootstrap|index)\\.ts$",
			},
		},
		{
			name: "no-circular",
			comment: "循環依存を禁止する",
			severity: "error",
			from: {},
			to: { circular: true },
		},
	],
	options: {
		doNotFollow: {
			path: "node_modules",
		},
		tsPreCompilationDeps: true,
		exclude: {
			path: ["\\.test\\.ts$", "test-helpers\\.ts$"],
		},
	},
};
