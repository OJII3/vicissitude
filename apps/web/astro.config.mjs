// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
	server: {
		// デフォルト値は shared/config.ts と同期すること
		port: Number(process.env.WEB_PORT ?? 4000),
		host: true,
	},
});
