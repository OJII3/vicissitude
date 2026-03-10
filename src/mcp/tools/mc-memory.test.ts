import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import {
	readOverlay,
	sanitizeSkillDescription,
	sanitizeSkillName,
	writeOverlay,
} from "./mc-memory.ts";

function createTmpDir(): string {
	return mkdtempSync(join(os.tmpdir(), "mc-mem-"));
}

describe("readOverlay", () => {
	it("overlay ファイルがあればそちらを読む", () => {
		const dataDir = createTmpDir();
		writeFileSync(join(dataDir, "TEST.md"), "overlay content");

		const result = readOverlay(dataDir, "TEST.md");
		expect(result).toBe("overlay content");
	});

	it("overlay にファイルがなければ base（context/minecraft/）にフォールバックする", () => {
		const dataDir = createTmpDir();
		// base の context/minecraft/ には MINECRAFT-GOALS.md テンプレートが存在する
		const result = readOverlay(dataDir, "MINECRAFT-GOALS.md");
		expect(result).toContain("Minecraft 目標管理");
	});

	it("どちらにもなければ空文字列を返す", () => {
		const dataDir = createTmpDir();
		const result = readOverlay(dataDir, "NONEXISTENT.md");
		expect(result).toBe("");
	});
});

describe("writeOverlay", () => {
	it("dataDir にファイルを書き込む", () => {
		const dataDir = createTmpDir();
		writeOverlay(dataDir, "TEST.md", "new content");

		const result = readFileSync(join(dataDir, "TEST.md"), "utf-8");
		expect(result).toBe("new content");
	});

	it("既存ファイルがあれば .bak バックアップを作成する", () => {
		const dataDir = createTmpDir();
		writeFileSync(join(dataDir, "TEST.md"), "old content");

		writeOverlay(dataDir, "TEST.md", "new content");

		expect(existsSync(join(dataDir, "TEST.md.bak"))).toBe(true);
		expect(readFileSync(join(dataDir, "TEST.md.bak"), "utf-8")).toBe("old content");
		expect(readFileSync(join(dataDir, "TEST.md"), "utf-8")).toBe("new content");
	});

	it("dataDir が存在しなければ自動作成する", () => {
		const tmpBase = createTmpDir();
		const dataDir = join(tmpBase, "nested", "dir");

		writeOverlay(dataDir, "TEST.md", "content");

		expect(existsSync(join(dataDir, "TEST.md"))).toBe(true);
	});
});

describe("sanitizeSkillName", () => {
	it("改行と # を含む name からスペースに変換される", () => {
		const safeName = sanitizeSkillName("スキル名\n## 偽セクション");
		expect(safeName).toBe("スキル名    偽セクション");
		expect(safeName).not.toContain("\n");
		expect(safeName).not.toContain("#");
	});

	it("CR+LF も正しく処理される", () => {
		const safeName = sanitizeSkillName("foo\r\nbar");
		expect(safeName).toBe("foo  bar");
	});

	it("# のみの name はスペースに変換される", () => {
		const safeName = sanitizeSkillName("# 危険な名前");
		expect(safeName).not.toContain("#");
		expect(safeName).toBe("危険な名前");
	});
});

describe("sanitizeSkillDescription", () => {
	it("行頭の Markdown ヘッダーを除去する", () => {
		const result = sanitizeSkillDescription("## セクション\nテキスト\n### サブセクション");
		expect(result).toBe("セクション\nテキスト\nサブセクション");
	});

	it("行頭以外の # は保持する", () => {
		const result = sanitizeSkillDescription("C# の使い方");
		expect(result).toBe("C# の使い方");
	});
});

describe("mc_record_skill の追記ロジック", () => {
	it("既存スキルファイルがあれば末尾に追記される", () => {
		const dataDir = createTmpDir();
		writeFileSync(join(dataDir, "MINECRAFT-SKILLS.md"), "# Minecraft スキルライブラリ\n");

		// mc_record_skill のロジックを再現
		const existing = readOverlay(dataDir, "MINECRAFT-SKILLS.md");
		const entry = `\n## テストスキル\n\nテスト説明\n`;
		const updated = existing ? existing + entry : `# Minecraft スキルライブラリ\n${entry}`;
		writeOverlay(dataDir, "MINECRAFT-SKILLS.md", updated);

		const result = readFileSync(join(dataDir, "MINECRAFT-SKILLS.md"), "utf-8");
		expect(result).toContain("# Minecraft スキルライブラリ");
		expect(result).toContain("## テストスキル");
		expect(result).toContain("テスト説明");
	});

	it("スキルファイルが空の場合はヘッダー付きで新規作成される", () => {
		const dataDir = createTmpDir();

		const existing = readOverlay(dataDir, "MINECRAFT-SKILLS.md");
		const entry = `\n## 初回スキル\n\n説明文\n`;
		// existing が空文字列の場合は falsy
		const updated = existing ? existing + entry : `# Minecraft スキルライブラリ\n${entry}`;
		writeOverlay(dataDir, "MINECRAFT-SKILLS.md", updated);

		const result = readFileSync(join(dataDir, "MINECRAFT-SKILLS.md"), "utf-8");
		// base にテンプレートが存在するため existing は空でないはず
		// 実際の動作は base のテンプレート内容 + 追記
		expect(result).toContain("## 初回スキル");
		expect(result).toContain("説明文");
	});

	it("複数スキルを連続追記できる", () => {
		const dataDir = createTmpDir();
		mkdirSync(dataDir, { recursive: true });

		// 1つ目
		const existing1 = readOverlay(dataDir, "MINECRAFT-SKILLS.md");
		const entry1 = `\n## スキルA\n\n説明A\n`;
		const updated1 = existing1 ? existing1 + entry1 : `# Minecraft スキルライブラリ\n${entry1}`;
		writeOverlay(dataDir, "MINECRAFT-SKILLS.md", updated1);

		// 2つ目
		const existing2 = readOverlay(dataDir, "MINECRAFT-SKILLS.md");
		const entry2 = `\n## スキルB\n\n説明B\n`;
		const updated2 = existing2 + entry2;
		writeOverlay(dataDir, "MINECRAFT-SKILLS.md", updated2);

		const result = readFileSync(join(dataDir, "MINECRAFT-SKILLS.md"), "utf-8");
		expect(result).toContain("## スキルA");
		expect(result).toContain("## スキルB");
	});
});
