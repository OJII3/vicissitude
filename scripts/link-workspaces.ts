/**
 * Bun 1.3.x のワークスペース symlink 未作成バグの回避策。
 * postinstall で実行し、packages/* を node_modules/@vicissitude/ にリンクする。
 */
import { existsSync, mkdirSync, readdirSync, symlinkSync, lstatSync, unlinkSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const scope = resolve(root, "node_modules/@vicissitude");
const packagesDir = resolve(root, "packages");

if (!existsSync(scope)) mkdirSync(scope, { recursive: true });

for (const name of readdirSync(packagesDir)) {
	const target = resolve(packagesDir, name);
	const link = resolve(scope, name);
	if (existsSync(link)) {
		const stat = lstatSync(link);
		if (stat.isSymbolicLink()) unlinkSync(link);
		else continue;
	}
	symlinkSync(target, link);
}

console.log(`[link-workspaces] linked ${readdirSync(scope).length} workspace packages`);
