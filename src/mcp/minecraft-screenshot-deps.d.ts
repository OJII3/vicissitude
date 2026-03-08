/* eslint-disable max-classes-per-file */
declare module "three" {
	export class WebGLRenderer {
		constructor(options: { canvas: unknown; antialias?: boolean });
		render(scene: unknown, camera: unknown): void;
		dispose(): void;
	}
}

declare module "node-canvas-webgl" {
	export function createCanvas(
		width: number,
		height: number,
	): {
		createPNGStream(): NodeJS.ReadableStream;
	};
}

declare module "prismarine-viewer/viewer" {
	export class Viewer {
		constructor(renderer: unknown);
		scene: unknown;
		camera: unknown;
		setVersion(version: string): void;
		setFirstPersonCamera(pos: unknown, yaw: number, pitch: number): void;
		listen(worldView: WorldView): void;
		waitForChunksToRender(): Promise<void>;
	}
	export class WorldView {
		constructor(world: unknown, viewDistance: number, position: unknown);
		init(position: unknown): Promise<void>;
	}
	export function getBufferFromStream(stream: NodeJS.ReadableStream): Promise<Buffer>;
}
