import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export function resolveWebBuildOutDir(env: NodeJS.ProcessEnv = process.env): string {
	const outDir = env.WEB_DIST_DIR?.trim();
	return outDir && outDir.length > 0 ? outDir : "dist";
}

export function createWebViteConfig(env: NodeJS.ProcessEnv = process.env) {
	return defineConfig({
		plugins: [
			tanstackRouter({
				target: "react",
				autoCodeSplitting: true,
				enableRouteGeneration: env.TANSTACK_ROUTE_GENERATION !== "false",
			}),
			react(),
			tailwindcss(),
		],
		build: {
			outDir: resolveWebBuildOutDir(env),
		},
		server: {
			port: Number(env.WEB_PORT ?? 4000),
			host: true,
			allowedHosts: true,
		},
	});
}

export default createWebViteConfig();
