/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
	forbidden: [
		{
			name: "gateway-no-scheduling",
			comment: "gateway は scheduling に依存しない。",
			from: { path: "^src/gateway" },
			to: { path: "^src/scheduling" },
		},
		{
			name: "mcp-no-gateway",
			comment: "mcp は gateway ではなく application/infrastructure を使う。",
			from: { path: "^src/mcp" },
			to: { path: "^src/gateway" },
		},
		{
			name: "application-no-interface-adapters",
			comment: "application は interface/infrastructure 層に依存しない。",
			from: { path: "^src/application" },
			to: { path: "^src/(gateway|mcp|infrastructure)" },
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
