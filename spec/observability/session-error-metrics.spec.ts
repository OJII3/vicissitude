/**
 * セッションエラー検知改善: メトリクス定義の仕様テスト
 *
 * 期待仕様:
 * 1. METRIC オブジェクトに SESSION_ERRORS, SESSION_RESTARTS, EVENT_BUFFER_POLL_ERRORS が定義されている
 * 2. 各メトリクスが PrometheusCollector で正しくカウンタとして動作する
 */
import { describe, expect, it } from "bun:test";

import { METRIC, PrometheusCollector } from "@vicissitude/observability/metrics";

// ─── メトリクス定義の存在確認 ─────────────────────────────────────

describe("METRIC 定数: セッションエラー関連", () => {
	it("SESSION_ERRORS が定義されている", () => {
		expect(METRIC.SESSION_ERRORS).toBe("session_errors_total");
	});

	it("SESSION_RESTARTS が定義されている", () => {
		expect(METRIC.SESSION_RESTARTS).toBe("session_restarts_total");
	});

	it("EVENT_BUFFER_POLL_ERRORS が定義されている", () => {
		expect(METRIC.EVENT_BUFFER_POLL_ERRORS).toBe("event_buffer_poll_errors_total");
	});
});

// ─── カウンタ動作の検証 ──────────────────────────────────────────

describe("SESSION_ERRORS カウンタ", () => {
	it("source, error_type ラベル付きでインクリメントできる", () => {
		const c = new PrometheusCollector();
		c.registerCounter(METRIC.SESSION_ERRORS, "session errors");
		c.incrementCounter(METRIC.SESSION_ERRORS, {
			source: "promptAsyncAndWatchSession",
			error_type: "session_error",
		});
		c.incrementCounter(METRIC.SESSION_ERRORS, {
			source: "waitForSessionIdle",
			error_type: "session_error",
		});
		c.incrementCounter(METRIC.SESSION_ERRORS, {
			source: "promptAsyncAndWatchSession",
			error_type: "stream_disconnected",
		});

		const output = c.serialize();
		expect(output).toContain(
			'session_errors_total{error_type="session_error",source="promptAsyncAndWatchSession"} 1',
		);
		expect(output).toContain(
			'session_errors_total{error_type="session_error",source="waitForSessionIdle"} 1',
		);
		expect(output).toContain(
			'session_errors_total{error_type="stream_disconnected",source="promptAsyncAndWatchSession"} 1',
		);
	});
});

describe("SESSION_RESTARTS カウンタ", () => {
	it("reason ラベル付きでインクリメントできる", () => {
		const c = new PrometheusCollector();
		c.registerCounter(METRIC.SESSION_RESTARTS, "session restarts");
		c.incrementCounter(METRIC.SESSION_RESTARTS, { reason: "error" });
		c.incrementCounter(METRIC.SESSION_RESTARTS, { reason: "error" });
		c.incrementCounter(METRIC.SESSION_RESTARTS, { reason: "hang_detected" });

		const output = c.serialize();
		expect(output).toContain('session_restarts_total{reason="error"} 2');
		expect(output).toContain('session_restarts_total{reason="hang_detected"} 1');
	});
});

describe("EVENT_BUFFER_POLL_ERRORS カウンタ", () => {
	it("ラベルなしでインクリメントできる", () => {
		const c = new PrometheusCollector();
		c.registerCounter(METRIC.EVENT_BUFFER_POLL_ERRORS, "event buffer poll errors");
		c.incrementCounter(METRIC.EVENT_BUFFER_POLL_ERRORS);
		c.incrementCounter(METRIC.EVENT_BUFFER_POLL_ERRORS);

		const output = c.serialize();
		expect(output).toContain("event_buffer_poll_errors_total 2");
	});
});
