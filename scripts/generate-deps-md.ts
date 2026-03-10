/**
 * depcruise JSON → docs/DEPS.md + src/{module}/DEPS.md 生成スクリプト
 *
 * Usage: depcruise src --config .dependency-cruiser.cjs --output-type json | bun scripts/generate-deps-md.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface DepcruiseModule {
	source: string;
	dependencies: Array<{
		module: string;
		resolved: string;
	}>;
}

interface DepcruiseOutput {
	modules: DepcruiseModule[];
}

const SRC_PREFIX = "src/";

function getModuleName(filePath: string): string | null {
	if (!filePath.startsWith(SRC_PREFIX)) return null;
	const rest = filePath.slice(SRC_PREFIX.length);
	if (rest === "bootstrap.ts" || rest === "index.ts") return null;
	const firstSlash = rest.indexOf("/");
	if (firstSlash === -1) return null;
	return rest.slice(0, firstSlash);
}

/** ファイル名（.ts 拡張子なし、モジュールプレフィックスなし） */
function getFileName(filePath: string, moduleName: string): string {
	const prefix = `${SRC_PREFIX}${moduleName}/`;
	return filePath.slice(prefix.length).replace(/\.ts$/, "");
}

function isExternalDep(resolved: string): boolean {
	return !resolved.startsWith("src/");
}

function getExternalPackage(resolved: string): string {
	if (resolved.startsWith("node_modules/")) {
		const parts = resolved.slice("node_modules/".length).split("/");
		const scope = parts[0] ?? "";
		return scope.startsWith("@") ? `${scope}/${parts[1] ?? ""}` : scope;
	}
	return resolved;
}

// --- トップレベル分析（モジュール単位） ---

interface ModuleInfo {
	internalDeps: Set<string>;
	externalDeps: Set<string>;
	fileCount: number;
}

function analyzeModules(data: DepcruiseOutput): Map<string, ModuleInfo> {
	const modules = new Map<string, ModuleInfo>();

	for (const mod of data.modules) {
		const modName = getModuleName(mod.source);
		if (modName === null) continue;

		if (!modules.has(modName)) {
			modules.set(modName, {
				internalDeps: new Set(),
				externalDeps: new Set(),
				fileCount: 0,
			});
		}
		const info = modules.get(modName);
		if (!info) continue;
		info.fileCount++;

		for (const dep of mod.dependencies) {
			const depMod = getModuleName(dep.resolved);
			if (depMod !== null && depMod !== modName) {
				info.internalDeps.add(depMod);
			} else if (isExternalDep(dep.resolved)) {
				info.externalDeps.add(getExternalPackage(dep.resolved));
			}
		}
	}

	return modules;
}

function generateTopLevelMermaid(modules: Map<string, ModuleInfo>): string {
	const lines: string[] = ["graph LR"];
	const sortedNames = [...modules.keys()].toSorted();

	for (const name of sortedNames) {
		const info = modules.get(name);
		if (!info) continue;
		if (info.internalDeps.size === 0) {
			lines.push(`  ${name}`);
		}
		for (const dep of [...info.internalDeps].toSorted()) {
			lines.push(`  ${name} --> ${dep}`);
		}
	}

	return lines.join("\n");
}

function generateModuleDetails(modules: Map<string, ModuleInfo>): string {
	const sortedNames = [...modules.keys()].toSorted();
	const sections: string[] = [];

	for (const name of sortedNames) {
		const info = modules.get(name);
		if (!info) continue;
		const internalDeps =
			info.internalDeps.size > 0
				? [...info.internalDeps]
						.toSorted()
						.map((d) => `${d}/`)
						.join(", ")
				: "なし";
		const externalDeps =
			info.externalDeps.size > 0 ? [...info.externalDeps].toSorted().join(", ") : "なし";

		sections.push(
			`### ${name}/\n- 内部依存: ${internalDeps}\n- 外部依存: ${externalDeps}\n- ファイル数: ${info.fileCount}`,
		);
	}

	return sections.join("\n\n");
}

function generateTopLevelDeps(data: DepcruiseOutput): string {
	const modules = analyzeModules(data);
	return `# 依存関係グラフ（自動生成）

> commit 時に自動再生成。手動編集禁止。

## モジュール依存関係図

\`\`\`mermaid
${generateTopLevelMermaid(modules)}
\`\`\`

## モジュール別依存一覧

${generateModuleDetails(modules)}
`;
}

// --- モジュール別分析（ファイル単位） ---

interface FileInfo {
	/** 同一モジュール内の依存ファイル名 */
	internalFiles: Set<string>;
	/** 他モジュールへの依存 */
	crossModuleDeps: Set<string>;
	/** 外部パッケージへの依存 */
	externalDeps: Set<string>;
}

function analyzeModuleFiles(data: DepcruiseOutput, moduleName: string): Map<string, FileInfo> {
	const files = new Map<string, FileInfo>();
	const prefix = `${SRC_PREFIX}${moduleName}/`;

	for (const mod of data.modules) {
		if (!mod.source.startsWith(prefix)) continue;
		const fileName = getFileName(mod.source, moduleName);

		if (!files.has(fileName)) {
			files.set(fileName, {
				internalFiles: new Set(),
				crossModuleDeps: new Set(),
				externalDeps: new Set(),
			});
		}
		const info = files.get(fileName);
		if (!info) continue;

		for (const dep of mod.dependencies) {
			if (dep.resolved.startsWith(prefix)) {
				// 同一モジュール内
				const depFile = getFileName(dep.resolved, moduleName);
				if (depFile !== fileName) {
					info.internalFiles.add(depFile);
				}
			} else {
				const depMod = getModuleName(dep.resolved);
				if (depMod !== null) {
					info.crossModuleDeps.add(`${depMod}/`);
				} else if (isExternalDep(dep.resolved)) {
					info.externalDeps.add(getExternalPackage(dep.resolved));
				}
			}
		}
	}

	return files;
}

function generateModuleMermaid(files: Map<string, FileInfo>): string {
	const lines: string[] = ["graph LR"];
	const sortedNames = [...files.keys()].toSorted();

	for (const name of sortedNames) {
		const info = files.get(name);
		if (!info) continue;

		// Mermaid のノード ID にスラッシュが含まれる場合があるので引用符で囲む
		const nodeId = mermaidId(name);

		if (info.internalFiles.size === 0) {
			lines.push(`  ${nodeId}`);
		}
		for (const dep of [...info.internalFiles].toSorted()) {
			lines.push(`  ${nodeId} --> ${mermaidId(dep)}`);
		}
	}

	return lines.join("\n");
}

/** Mermaid のノード ID: スラッシュやハイフンを含む場合は安全な ID + ["label"] 形式にする */
function mermaidId(name: string): string {
	if (name.includes("/") || name.includes("-")) {
		const safeId = name.replaceAll("/", "_").replaceAll("-", "_");
		return `${safeId}["${name}"]`;
	}
	return name;
}

function generateModuleFileList(files: Map<string, FileInfo>): string {
	const sortedNames = [...files.keys()].toSorted();
	const sections: string[] = [];

	for (const name of sortedNames) {
		const info = files.get(name);
		if (!info) continue;

		const parts: string[] = [`### ${name}.ts`];

		if (info.internalFiles.size > 0) {
			parts.push(`- モジュール内依存: ${[...info.internalFiles].toSorted().join(", ")}`);
		}
		if (info.crossModuleDeps.size > 0) {
			parts.push(`- 他モジュール依存: ${[...info.crossModuleDeps].toSorted().join(", ")}`);
		}
		if (info.externalDeps.size > 0) {
			parts.push(`- 外部依存: ${[...info.externalDeps].toSorted().join(", ")}`);
		}
		if (
			info.internalFiles.size === 0 &&
			info.crossModuleDeps.size === 0 &&
			info.externalDeps.size === 0
		) {
			parts.push("- 依存なし");
		}

		sections.push(parts.join("\n"));
	}

	return sections.join("\n\n");
}

function generateModuleDeps(data: DepcruiseOutput, moduleName: string): string {
	const files = analyzeModuleFiles(data, moduleName);
	if (files.size === 0) return "";

	return `# ${moduleName}/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

\`\`\`mermaid
${generateModuleMermaid(files)}
\`\`\`

## ファイル別依存一覧

${generateModuleFileList(files)}
`;
}

// --- メイン ---

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function main() {
	const input = readFileSync("/dev/stdin", "utf-8");
	const data: DepcruiseOutput = JSON.parse(input);

	// トップレベル docs/DEPS.md
	writeFile("docs/DEPS.md", generateTopLevelDeps(data));

	// モジュール別 src/{module}/DEPS.md
	const moduleNames = new Set<string>();
	for (const mod of data.modules) {
		const name = getModuleName(mod.source);
		if (name !== null) moduleNames.add(name);
	}

	for (const moduleName of [...moduleNames].toSorted()) {
		const content = generateModuleDeps(data, moduleName);
		if (content) {
			writeFile(`src/${moduleName}/DEPS.md`, content);
		}
	}
}

main();
