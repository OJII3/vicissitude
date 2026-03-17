import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [TanStackRouterVite(), react(), tailwindcss()],
	server: {
		port: Number(process.env.WEB_PORT ?? 4000),
		host: true,
		allowedHosts: true,
	},
});
