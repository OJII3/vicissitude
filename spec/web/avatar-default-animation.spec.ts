import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_IDLE_ANIMATION_URL } from "../../apps/web/src/components/avatar/avatar-assets";

describe("web avatar default animation", () => {
	it("uses Project AIRI idle motion as the default idle animation", () => {
		expect(DEFAULT_IDLE_ANIMATION_URL).toBe("/models/animations/project-airi-idle-loop.vrma");
	});

	it("ships the default idle animation asset with the web public files", () => {
		const relativeAssetPath = DEFAULT_IDLE_ANIMATION_URL.replace(/^\//, "");
		const assetPath = join(import.meta.dir, "../../apps/web/public", relativeAssetPath);

		expect(existsSync(assetPath)).toBe(true);
	});
});
