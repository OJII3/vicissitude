import { extname, isAbsolute, relative, resolve } from "node:path";

const DEFAULT_DIST_DIR = "apps/web/dist";
const DEFAULT_PORT = 4000;

const CONTENT_TYPES = new Map([
	[".avif", "image/avif"],
	[".css", "text/css; charset=utf-8"],
	[".gif", "image/gif"],
	[".html", "text/html; charset=utf-8"],
	[".ico", "image/x-icon"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".png", "image/png"],
	[".svg", "image/svg+xml; charset=utf-8"],
	[".vrm", "model/gltf-binary"],
	[".wasm", "application/wasm"],
	[".webp", "image/webp"],
]);

export function resolveAssetPath(pathname: string, distDir: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}

	if (decoded.includes("\0")) return null;
	if (decoded.split(/[\\/]+/).includes("..")) return null;

	const relativePath = decoded.replace(/^[/\\]+/, "") || "index.html";
	const assetPath = resolve(distDir, relativePath);
	return isWithinDirectory(assetPath, distDir) ? assetPath : null;
}

export function createWebFetchHandler(distDir: string): (request: Request) => Promise<Response> {
	const resolvedDistDir = resolve(distDir);

	return async (request) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { Allow: "GET, HEAD" },
			});
		}

		const url = new URL(request.url);
		const assetPath = resolveAssetPath(url.pathname, resolvedDistDir);
		if (assetPath === null) return new Response("Bad Request", { status: 400 });

		const assetResponse = await createFileResponse(assetPath, request.method);
		if (assetResponse) return assetResponse;

		if (extname(url.pathname) === "") {
			const fallbackResponse = await createFileResponse(
				resolve(resolvedDistDir, "index.html"),
				request.method,
			);
			if (fallbackResponse) return fallbackResponse;
		}

		return new Response("Not Found", { status: 404 });
	};
}

function isWithinDirectory(path: string, directory: string): boolean {
	const relativePath = relative(resolve(directory), path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function createFileResponse(path: string, method: string): Promise<Response | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;

	return new Response(method === "HEAD" ? null : file, {
		headers: {
			"Content-Type": CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream",
		},
	});
}

if (import.meta.main) {
	const port = Number(process.env.WEB_PORT ?? DEFAULT_PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`[web] invalid WEB_PORT: ${process.env.WEB_PORT}`);
		process.exit(1);
	}

	const distDir = process.env.WEB_DIST_DIR ?? DEFAULT_DIST_DIR;
	const server = Bun.serve({
		hostname: "0.0.0.0",
		port,
		fetch: createWebFetchHandler(distDir),
	});

	console.log(`[web] serving ${resolve(distDir)} at http://${server.hostname}:${server.port}`);
}
