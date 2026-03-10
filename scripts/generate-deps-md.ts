/**
 * depcruise JSON → docs/DEPS.md 変換スクリプト
 *
 * Usage: depcruise src --config .dependency-cruiser.cjs --output-type json | bun scripts/generate-deps-md.ts > docs/DEPS.md
 */

import { readFileSync } from "node:fs";

interface DepcruiseModule {
	source: string;
	dependencies: Array<{
		module: string;
		resolved: string;
		moduleSystem: string;
		circular?: boolean;
		valid: boolean;
		rules?: Array<{ name: string; severity: string }>;
	}>;
	valid: boolean;
	rules?: Array<{ name: string; severity: string }>;
}

interface DepcruiseOutput {
	modules: DepcruiseModule[];
	summary: {
		violations: Array<{
			type: string;
			from: string;
			to: string;
			rule: { name: string; severity: string };
			cycle?: string[];
		}>;
		totalCruised: number;
		totalDependenciesCruised: number;
		error: number;
		warn: number;
		info: number;
		optionalDependencies: number;
	};
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

interface ModuleInfo {
	internalDeps: Set<string>;
	externalDeps: Set<string>;
	fileCount: number;
}

function analyze(data: DepcruiseOutput): Map<string, ModuleInfo> {
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

function generateMermaid(modules: Map<string, ModuleInfo>): string {
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

function generateViolations(data: DepcruiseOutput): string {
	const violations = data.summary.violations;
	if (violations.length === 0) return "なし";

	const lines: string[] = [];
	for (const v of violations) {
		if (v.cycle) {
			lines.push(`- **${v.rule.name}** (${v.rule.severity}): ${v.cycle.join(" → ")}`);
		} else {
			lines.push(`- **${v.rule.name}** (${v.rule.severity}): ${v.from} → ${v.to}`);
		}
	}
	return lines.join("\n");
}

function main() {
	const input = readFileSync("/dev/stdin", "utf-8");
	const data: DepcruiseOutput = JSON.parse(input);
	const modules = analyze(data);

	const now = new Date().toISOString();

	const output = `# 依存関係グラフ（自動生成）

> \`nr deps:graph\` で再生成。手動編集禁止。

## モジュール依存関係図

\`\`\`mermaid
${generateMermaid(modules)}
\`\`\`

## モジュール別依存一覧

${generateModuleDetails(modules)}

## ルール違反

${generateViolations(data)}

---
Generated at: ${now}
`;

	process.stdout.write(output);
}

main();
