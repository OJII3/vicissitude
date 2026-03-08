import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import type mineflayer from "mineflayer";

const SCREENSHOT_DIR = "/tmp/vicissitude-screenshots";
const RENDER_TIMEOUT_MS = 10_000;

interface ScreenshotResult {
	filePath: string;
	base64: string;
}

interface ScreenshotOptions {
	width?: number;
	height?: number;
	viewDistance?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<"timeout">((_resolve) => {
		timer = setTimeout(() => _resolve("timeout"), ms);
	});
	return Promise.race([
		promise.then((v) => {
			clearTimeout(timer);
			return v;
		}),
		timeout,
	]);
}

function savePngBuffer(buffer: Buffer): string {
	if (!existsSync(SCREENSHOT_DIR)) {
		mkdirSync(SCREENSHOT_DIR, { recursive: true });
	}
	const filePath = `${SCREENSHOT_DIR}/screenshot-${String(Date.now())}.png`;
	writeFileSync(filePath, buffer);
	return filePath;
}

// Module-level cache for dynamic imports (initialized once)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import cache; typed at usage site
let cachedModules: Record<string, any> | null = null;

async function loadModules() {
	if (cachedModules) return cachedModules;

	const THREE = await import("three");
	const { createCanvas } = await import("node-canvas-webgl");
	const { Viewer, WorldView, getBufferFromStream } = await import("prismarine-viewer/viewer");

	// @ts-expect-error prismarine-viewer requires global THREE
	global.THREE = THREE;

	cachedModules = { THREE, createCanvas, Viewer, WorldView, getBufferFromStream };
	return cachedModules;
}

// eslint-disable-next-line max-lines-per-function -- rendering setup requires sequential steps
export async function takeScreenshot(
	bot: mineflayer.Bot,
	options?: ScreenshotOptions,
): Promise<ScreenshotResult> {
	const width = options?.width ?? 512;
	const height = options?.height ?? 512;
	const viewDistance = options?.viewDistance ?? 4;

	const { THREE, createCanvas, Viewer, WorldView, getBufferFromStream } = await loadModules();

	const canvas = createCanvas(width, height);
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	const viewer = new Viewer(renderer);

	try {
		viewer.setVersion(bot.version);
		viewer.setFirstPersonCamera(bot.entity.position, bot.entity.yaw, bot.entity.pitch);

		const worldView = new WorldView(bot.world, viewDistance, bot.entity.position);
		viewer.listen(worldView);
		await worldView.init(bot.entity.position);

		// Wait for chunks; timeout is non-fatal — render whatever is loaded
		await withTimeout(viewer.waitForChunksToRender(), RENDER_TIMEOUT_MS);

		renderer.render(viewer.scene, viewer.camera);

		const stream = canvas.createPNGStream();
		const buffer: Buffer = await getBufferFromStream(stream);
		const filePath = savePngBuffer(buffer);

		return { filePath, base64: buffer.toString("base64") };
	} finally {
		renderer.dispose();
	}
}
