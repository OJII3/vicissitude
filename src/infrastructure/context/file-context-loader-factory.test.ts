import { describe, expect, it } from "bun:test";

import { FileContextLoaderFactory } from "./file-context-loader-factory.ts";

describe("FileContextLoaderFactory", () => {
	it("guildId 未指定で ContextLoader を生成できる", () => {
		const factory = new FileContextLoaderFactory("/tmp/context");
		const loader = factory.create();
		expect(loader).toBeDefined();
	});

	it("正常な snowflake guildId で ContextLoader を生成できる", () => {
		const factory = new FileContextLoaderFactory("/tmp/context");
		const loader = factory.create("123456789012345678");
		expect(loader).toBeDefined();
	});

	it("不正な guildId（パストラバーサル）でエラーをスローする", () => {
		const factory = new FileContextLoaderFactory("/tmp/context");
		expect(() => factory.create("../../../etc")).toThrow("Invalid guildId");
	});

	it("英字を含む guildId でエラーをスローする", () => {
		const factory = new FileContextLoaderFactory("/tmp/context");
		expect(() => factory.create("abc123")).toThrow("Invalid guildId");
	});

	it("空文字列の guildId でエラーをスローする", () => {
		const factory = new FileContextLoaderFactory("/tmp/context");
		expect(() => factory.create("")).toThrow("Invalid guildId");
	});
});
