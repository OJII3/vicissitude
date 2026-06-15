/**
 * heartbeat session-key 規約プリミティブ 仕様テスト
 *
 * 目的:
 *   heartbeat 実行の session-key 規約（`system:heartbeat:{scopeKey}`）を
 *   `@vicissitude/shared/namespace` に単一ソース化する。
 *   - 生成側: application/heartbeat-service が heartbeatSessionKey で session-key を作る。
 *   - 解析側: observability/metrics が scopeKeyFromHeartbeatSessionKey で scope を取り出す。
 *
 * これらは「規約」プリミティブであり、observability 固有のラベル語彙
 * （trigger="heartbeat" 等）は含まない（metrics 側の責務）。
 */

import { describe, expect, it } from "bun:test";

import {
	HEARTBEAT_SESSION_PREFIX,
	heartbeatSessionKey,
	scopeKeyFromHeartbeatSessionKey,
} from "@vicissitude/shared/namespace";

describe("HEARTBEAT_SESSION_PREFIX", () => {
	it("session-key プレフィックスは 'system:heartbeat:' である", () => {
		expect(HEARTBEAT_SESSION_PREFIX).toBe("system:heartbeat:");
	});
});

describe("heartbeatSessionKey", () => {
	it("canonical scopeId から heartbeat session-key を生成する", () => {
		expect(heartbeatSessionKey("discord:guild:111")).toBe("system:heartbeat:discord:guild:111");
	});

	it("グローバル heartbeat の '_autonomous' をそのまま付与する", () => {
		expect(heartbeatSessionKey("_autonomous")).toBe("system:heartbeat:_autonomous");
	});

	it("プレフィックスと scopeKey の連結であり、scopeKey を検証しない", () => {
		// heartbeat-service は scopeKey をそのまま渡す規約のため、ここでは throw しない
		expect(heartbeatSessionKey("guild-1")).toBe("system:heartbeat:guild-1");
	});
});

describe("scopeKeyFromHeartbeatSessionKey", () => {
	it("heartbeat session-key から scopeKey を取り出す", () => {
		expect(scopeKeyFromHeartbeatSessionKey("system:heartbeat:discord:guild:111")).toBe(
			"discord:guild:111",
		);
	});

	it("'_autonomous' を生の残余文字列としてそのまま返す", () => {
		expect(scopeKeyFromHeartbeatSessionKey("system:heartbeat:_autonomous")).toBe("_autonomous");
	});

	it("heartbeat 以外の session-key は null を返す", () => {
		expect(scopeKeyFromHeartbeatSessionKey("discord:guild:111")).toBeNull();
		expect(scopeKeyFromHeartbeatSessionKey("home")).toBeNull();
		expect(scopeKeyFromHeartbeatSessionKey("dm")).toBeNull();
	});

	it("生成と解析は往復する（round-trip）", () => {
		const scopeKey = "discord:guild:999";
		expect(scopeKeyFromHeartbeatSessionKey(heartbeatSessionKey(scopeKey))).toBe(scopeKey);
	});
});
