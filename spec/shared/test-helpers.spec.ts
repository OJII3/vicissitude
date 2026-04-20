import { describe, expect, it } from "bun:test";

import { createMockLogger } from "@vicissitude/shared/test-helpers";

// ─── createMockLogger ──────────────────────────────────────────

describe("createMockLogger", () => {
	it("returns an object satisfying the Logger interface", () => {
		const logger = createMockLogger();
		expect(typeof logger.debug).toBe("function");
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.warn).toBe("function");
		expect(typeof logger.error).toBe("function");
		expect(typeof logger.child).toBe("function");
	});
});

// ─── child() ───────────────────────────────────────────────────

describe("createMockLogger child()", () => {
	it("returns a different instance from the parent", () => {
		const parent = createMockLogger();
		const child = parent.child({ module: "test" });
		expect(child).not.toBe(parent);
	});

	it("returns an object satisfying the Logger interface", () => {
		const parent = createMockLogger();
		const child = parent.child({ module: "test" });
		expect(typeof child.debug).toBe("function");
		expect(typeof child.info).toBe("function");
		expect(typeof child.warn).toBe("function");
		expect(typeof child.error).toBe("function");
		expect(typeof child.child).toBe("function");
	});

	it("exposes created children via the children array", () => {
		const parent = createMockLogger();
		expect(parent.children).toHaveLength(0);

		const child = parent.child({ module: "test" });
		expect(parent.children).toHaveLength(1);
		expect(child).toBe(parent.children[0]);
	});

	it("keeps child mock calls independent from parent", () => {
		const parent = createMockLogger();
		const child = parent.child({ module: "test" });

		child.info("child message");

		expect(parent.info).not.toHaveBeenCalled();
		expect(child.info).toHaveBeenCalledTimes(1);
		expect(child.info).toHaveBeenCalledWith("child message");
	});

	it("keeps parent mock calls independent from child", () => {
		const parent = createMockLogger();
		const child = parent.child({ module: "test" });

		parent.error("parent error");

		expect(child.error).not.toHaveBeenCalled();
		expect(parent.error).toHaveBeenCalledTimes(1);
	});

	it("supports chaining — child of child is also trackable", () => {
		const root = createMockLogger();
		const child = root.child({ level: "1" });
		const grandchild = child.child({ level: "2" });

		// grandchild is a distinct instance
		expect(grandchild).not.toBe(child);
		expect(grandchild).not.toBe(root);

		// grandchild satisfies Logger
		expect(typeof grandchild.debug).toBe("function");
		expect(typeof grandchild.info).toBe("function");
		expect(typeof grandchild.warn).toBe("function");
		expect(typeof grandchild.error).toBe("function");
		expect(typeof grandchild.child).toBe("function");

		// children arrays track each level
		expect(root.children).toHaveLength(1);
		expect(child).toBe(root.children[0]);
		expect(child.children).toHaveLength(1);
		expect(grandchild).toBe(child.children[0]);
	});

	it("tracks multiple children independently", () => {
		const parent = createMockLogger();
		const childA = parent.child({ id: "a" });
		const childB = parent.child({ id: "b" });

		expect(parent.children).toHaveLength(2);
		expect(childA).toBe(parent.children[0]);
		expect(childB).toBe(parent.children[1]);

		childA.debug("from A");
		childB.warn("from B");

		expect(childA.debug).toHaveBeenCalledTimes(1);
		expect(childA.warn).not.toHaveBeenCalled();
		expect(childB.warn).toHaveBeenCalledTimes(1);
		expect(childB.debug).not.toHaveBeenCalled();
	});
});
