// パッケージ間の依存方向制約は oxlint の no-restricted-imports (.oxlintrc.json) に一本化。
// このファイルは DEPS.md 自動生成 (nr deps:graph) 専用。
/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
	forbidden: [],
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
