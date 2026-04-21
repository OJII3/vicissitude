/**
 * セッションエラー検知改善: メトリクス定義の仕様テスト
 *
 * 期待仕様:
 * 1. METRIC オブジェクトに SESSION_ERRORS, SESSION_RESTARTS, SESSION_RETRIES が定義されている
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

	it("SESSION_RETRIES が定義されている", () => {
		expect(METRIC.SESSION_RETRIES).toBe("session_retries_total");
	});
});

// ─── カウンタ動作の検証 ──────────────────────────────────────────

describe("SESSION_ERRORS カウンタ", () => {
	it("source, error_type, http_status, retryable, error_class ラベル付きでインクリメントできる", () => {
		const c = new PrometheusCollector();
		c.registerCounter(METRIC.SESSION_ERRORS, "session errors");
		c.incrementCounter(METRIC.SESSION_ERRORS, {
			source: "session_event",
			error_type: "session_error",
			http_status: "400",
			retryable: "false",
			error_class: "APIError",
		});
		c.incrementCounter(METRIC.SESSION_ERRORS, {
			source: "session_event",
			error_type: "session_error",
			http_status: "502",
			retryable: "true",
			error_class: "APIError",
		});
		c.incrementCounter(METRIC.SESSION_ERRORS, {
			source: "session_event",
			error_type: "stream_disconnected",
			http_status: "unknown",
			retryable: "unknown",
			error_class: "unknown",
		});

		const output = c.serialize();
		expect(output).toContain(
			'session_errors_total{error_class="APIError",error_type="session_error",http_status="400",retryable="false",source="session_event"} 1',
		);
		expect(output).toContain(
			'session_errors_total{error_class="APIError",error_type="session_error",http_status="502",retryable="true",source="session_event"} 1',
		);
		expect(output).toContain(
			'session_errors_total{error_class="unknown",error_type="stream_disconnected",http_status="unknown",retryable="unknown",source="session_event"} 1',
		);
	});
});

describe("SESSION_RESTARTS カウンタ", () => {
	it("reason ラベル付きでインクリメントできる", () => {
		const c = new PrometheusCollector();
		c.registerCounter(METRIC.SESSION_RESTARTS, "session restarts");
		c.incrementCounter(METRIC.SESSION_RESTARTS, { reason: "error" });
		c.incrementCounter(METRIC.SESSION_RESTARTS, { reason: "error" });
		c.incrementCounter(METRIC.SESSION_RESTARTS, { reason: "hang_rotation" });

		const output = c.serialize();
		expect(output).toContain('session_restarts_total{reason="error"} 2');
		expect(output).toContain('session_restarts_total{reason="hang_rotation"} 1');
	});
});

describe("SESSION_RETRIES カウンタ", () => {
	it("error_type, attempt ラベル付きでインクリメントできる", () => {
		const c = new PrometheusCollector();
		c.registerCounter(METRIC.SESSION_RETRIES, "session retries");
		c.incrementCounter(METRIC.SESSION_RETRIES, {
			error_type: "session_error",
			attempt: "1",
		});
		c.incrementCounter(METRIC.SESSION_RETRIES, {
			error_type: "rate_limit",
			attempt: "2",
		});
		c.incrementCounter(METRIC.SESSION_RETRIES, {
			error_type: "session_error",
			attempt: "1",
		});

		const output = c.serialize();
		expect(output).toContain('session_retries_total{attempt="1",error_type="session_error"} 2');
		expect(output).toContain('session_retries_total{attempt="2",error_type="rate_limit"} 1');
	});
});
