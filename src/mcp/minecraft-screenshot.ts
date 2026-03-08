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

function timeoutPromise(ms: number): Promise<void> {
	return new Promise<void>((_resolve, reject) => {
		setTimeout(() => reject(new Error("チャンクレンダリングがタイムアウトしました")), ms);
	});
}

function savePngBuffer(buffer: Buffer): string {
	if (!existsSync(SCREENSHOT_DIR)) {
		mkdirSync(SCREENSHOT_DIR, { recursive: true });
	}
	const filePath = `${SCREENSHOT_DIR}/screenshot-${String(Date.now())}.png`;
	writeFileSync(filePath, buffer);
	return filePath;
}

// eslint-disable-next-line max-lines-per-function -- dynamic imports inflate line count
export async function takeScreenshot(
	bot: mineflayer.Bot,
	options?: ScreenshotOptions,
): Promise<ScreenshotResult> {
	const width = options?.width ?? 512;
	const height = options?.height ?? 512;
	const viewDistance = options?.viewDistance ?? 4;

	const THREE = await import("three");
	const { createCanvas } = await import("node-canvas-webgl");
	const { Viewer, WorldView, getBufferFromStream } = await import("prismarine-viewer/viewer");

	// @ts-expect-error prismarine-viewer requires global THREE
	global.THREE = THREE;

	const canvas = createCanvas(width, height);
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	const viewer = new Viewer(renderer);

	try {
		viewer.setVersion(bot.version);
		viewer.setFirstPersonCamera(bot.entity.position, bot.entity.yaw, bot.entity.pitch);

		const worldView = new WorldView(bot.world, viewDistance, bot.entity.position);
		viewer.listen(worldView);
		await worldView.init(bot.entity.position);

		// Timeout is non-fatal — render whatever is loaded
		await Promise.race([viewer.waitForChunksToRender(), timeoutPromise(RENDER_TIMEOUT_MS)]).catch(
			() => {},
		);

		renderer.render(viewer.scene, viewer.camera);

		const stream = canvas.createPNGStream();
		const buffer: Buffer = await getBufferFromStream(stream);
		const filePath = savePngBuffer(buffer);

		return { filePath, base64: buffer.toString("base64") };
	} finally {
		renderer.dispose();
	}
}
