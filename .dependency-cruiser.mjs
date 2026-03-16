/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
	forbidden: [
		// L0: shared, ollama — 他の workspace パッケージに依存しない
		{
			name: "shared-no-internal-deps",
			comment: "shared は他の workspace パッケージに依存しない。",
			from: { path: "^packages/shared" },
			to: { path: "^(packages|apps)/", pathNot: "^packages/shared/" },
		},
		{
			name: "ollama-no-internal-deps",
			comment: "ollama は他の workspace パッケージに依存しない。",
			from: { path: "^packages/ollama" },
			to: { path: "^(packages|apps)/", pathNot: "^packages/ollama/" },
		},
		// L1: observability, application, store, opencode — L0 のみに依存
		{
			name: "observability-only-L0",
			comment: "observability は shared のみに依存できる。",
			from: { path: "^packages/observability" },
			to: {
				path: "^packages/(?!shared/|observability/)",
			},
		},
		{
			name: "application-only-L0",
			comment: "application は shared のみに依存できる。",
			from: { path: "^packages/application" },
			to: {
				path: "^packages/(?!shared/|application/)",
			},
		},
		{
			name: "store-only-L0",
			comment: "store は shared のみに依存できる。",
			from: { path: "^packages/store" },
			to: {
				path: "^packages/(?!shared/|store/)",
			},
		},
		{
			name: "opencode-only-L0",
			comment: "opencode は shared のみに依存できる。",
			from: { path: "^packages/opencode" },
			to: {
				path: "^packages/(?!shared/|opencode/)",
			},
		},
		// L1 → apps 禁止
		{
			name: "L1-no-apps",
			comment: "L1 パッケージは apps に依存しない。",
			from: { path: "^packages/(observability|application|store|opencode)" },
			to: { path: "^apps/" },
		},
		// L2: ltm, infrastructure, agent, scheduling — 仕様通りの依存のみ
		{
			name: "ltm-allowed-deps",
			comment: "ltm は shared, ollama のみに依存できる。",
			from: { path: "^packages/ltm" },
			to: {
				path: "^packages/(?!shared/|ollama/|ltm/)",
			},
		},
		{
			name: "infrastructure-allowed-deps",
			comment: "infrastructure は shared, application, store のみに依存できる。",
			from: { path: "^packages/infrastructure" },
			to: {
				path: "^packages/(?!shared/|application/|store/|infrastructure/)",
			},
		},
		{
			name: "agent-allowed-deps",
			comment: "agent は shared, opencode, store のみに依存できる。",
			from: { path: "^packages/agent" },
			to: {
				path: "^packages/(?!shared/|opencode/|store/|agent/)",
			},
		},
		{
			name: "scheduling-allowed-deps",
			comment: "scheduling は shared, application, observability のみに依存できる。",
			from: { path: "^packages/scheduling" },
			to: {
				path: "^packages/(?!shared/|application/|observability/|scheduling/)",
			},
		},
		// L2 → apps 禁止
		{
			name: "L2-no-apps",
			comment: "L2 パッケージは apps に依存しない。",
			from: { path: "^packages/(ltm|infrastructure|agent|scheduling)" },
			to: { path: "^apps/" },
		},
		// L3: mcp, minecraft — 仕様通りの依存のみ
		{
			name: "mcp-allowed-deps",
			comment: "mcp は shared, infrastructure, ltm, ollama, store のみに依存できる。",
			from: { path: "^packages/mcp" },
			to: {
				path: "^packages/(?!shared/|infrastructure/|ltm/|ollama/|store/|mcp/)",
			},
		},
		{
			name: "minecraft-allowed-deps",
			comment: "minecraft は shared, store のみに依存できる。",
			from: { path: "^packages/minecraft" },
			to: {
				path: "^packages/(?!shared/|store/|minecraft/)",
			},
		},
		// L3 → apps 禁止
		{
			name: "L3-no-apps",
			comment: "L3 パッケージは apps に依存しない。",
			from: { path: "^packages/(mcp|minecraft)" },
			to: { path: "^apps/" },
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

export default config;
