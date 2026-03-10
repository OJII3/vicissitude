/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
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
