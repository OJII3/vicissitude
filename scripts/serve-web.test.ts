import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWebFetchHandler, resolveAssetPath } from "./serve-web.ts";

describe("serve-web", () => {
	test("asset path は distDir 内だけに解決する", () => {
		const distDir = "/tmp/vicissitude-web-dist";

		expect(resolveAssetPath("/", distDir)).toBe(join(distDir, "index.html"));
		expect(resolveAssetPath("/assets/app.js", distDir)).toBe(join(distDir, "assets/app.js"));
		expect(resolveAssetPath("/../secret.txt", distDir)).toBeNull();
		expect(resolveAssetPath("/%2e%2e/secret.txt", distDir)).toBeNull();
	});

	test("静的 asset を Content-Type 付きで返す", async () => {
		const distDir = makeTempDir();
		try {
			mkdirSync(join(distDir, "assets"));
			writeFileSync(join(distDir, "assets", "app.js"), "console.log('ok');\n");

			const response = await createWebFetchHandler(distDir)(
				new Request("http://example.test/assets/app.js"),
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
			expect(await response.text()).toBe("console.log('ok');\n");
		} finally {
			rmSync(distDir, { recursive: true, force: true });
		}
	});

	test("拡張子のない未知 path は SPA fallback として index.html を返す", async () => {
		const distDir = makeTempDir();
		try {
			writeFileSync(join(distDir, "index.html"), "<main>app</main>\n");

			const response = await createWebFetchHandler(distDir)(
				new Request("http://example.test/settings"),
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
			expect(await response.text()).toBe("<main>app</main>\n");
		} finally {
			rmSync(distDir, { recursive: true, force: true });
		}
	});

	test("存在しない asset path は 404 を返す", async () => {
		const distDir = makeTempDir();
		try {
			writeFileSync(join(distDir, "index.html"), "<main>app</main>\n");

			const response = await createWebFetchHandler(distDir)(
				new Request("http://example.test/assets/missing.js"),
			);

			expect(response.status).toBe(404);
		} finally {
			rmSync(distDir, { recursive: true, force: true });
		}
	});
});

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "vicissitude-web-"));
}
