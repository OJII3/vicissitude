import { describe, expect, test } from "bun:test";

import { createWebViteConfig, resolveWebBuildOutDir } from "./vite.config";

describe("vite.config", () => {
	test("WEB_DIST_DIR 未指定時は既定の dist を使う", () => {
		expect(resolveWebBuildOutDir({})).toBe("dist");
	});

	test("WEB_DIST_DIR 指定時は build outDir に反映する", () => {
		const env = {
			WEB_DIST_DIR: "/tmp/vicissitude-custom-dist",
			WEB_PORT: "4100",
			TANSTACK_ROUTE_GENERATION: "false",
		};

		expect(resolveWebBuildOutDir(env)).toBe("/tmp/vicissitude-custom-dist");
		const config = createWebViteConfig(env);
		expect(config.build?.outDir).toBe("/tmp/vicissitude-custom-dist");
		expect(config.server?.port).toBe(4100);
	});
});
