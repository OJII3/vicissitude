import { resolve } from "path";

/** プロジェクトルートパス（環境変数 or cwd） */
export const APP_ROOT = process.env.APP_ROOT ?? resolve(process.cwd());
