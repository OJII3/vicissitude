import { describe, expect, it } from "bun:test";

import { extractLearnedSection } from "./memory-server.ts";

describe("extractLearnedSection", () => {
	it("「学んだこと」セクションが存在しない場合、before に全文が入る", () => {
		const content = "# SOUL\n\n## 性格\nおだやか\n";
		const result = extractLearnedSection(content);

		expect(result.before).toBe(content);
		expect(result.section).toBe("");
		expect(result.after).toBe("");
	});

	it("「学んだこと」がファイル末尾のセクションの場合", () => {
		const content = "## 性格\nおだやか\n\n## 学んだこと\n\n- 挨拶は大事\n";
		const result = extractLearnedSection(content);

		expect(result.before).toBe("## 性格\nおだやか\n\n");
		expect(result.section).toBe("## 学んだこと\n\n- 挨拶は大事\n");
		expect(result.after).toBe("");
	});

	it("「学んだこと」の後に別セクションがある場合", () => {
		const content = "## 性格\nおだやか\n\n## 学んだこと\n\n- 挨拶は大事\n\n## 口調\nカジュアル\n";
		const result = extractLearnedSection(content);

		expect(result.before).toBe("## 性格\nおだやか\n\n");
		expect(result.section).toBe("## 学んだこと\n\n- 挨拶は大事\n");
		expect(result.after).toBe("\n## 口調\nカジュアル\n");
	});

	it("「学んだこと」がファイル先頭のセクションの場合", () => {
		const content = "## 学んだこと\n\n(まだ何も学んでいません。)\n\n## 性格\nおだやか\n";
		const result = extractLearnedSection(content);

		expect(result.before).toBe("");
		expect(result.section).toBe("## 学んだこと\n\n(まだ何も学んでいません。)\n");
		expect(result.after).toBe("\n## 性格\nおだやか\n");
	});

	it("before + section + after を結合すると元のコンテンツに一致する", () => {
		const content =
			"# SOUL\n\n## 性格\nおだやか\n\n## 学んだこと\n\n- 挨拶は大事\n\n## 口調\nカジュアル\n";
		const result = extractLearnedSection(content);

		expect(result.before + result.section + result.after).toBe(content);
	});
});
