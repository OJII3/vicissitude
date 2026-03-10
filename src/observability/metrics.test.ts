import { describe, expect, it } from "bun:test";

import { PrometheusCollector, inferTrigger } from "./metrics.ts";

// ─── Counter ─────────────────────────────────────────────────────

describe("PrometheusCollector counter", () => {
	it("increment() で値が増加する", () => {
		const c = new PrometheusCollector();
		c.registerCounter("test_total", "test counter");
		c.incrementCounter("test_total");
		c.incrementCounter("test_total");
		const output = c.serialize();
		expect(output).toContain("test_total 2");
	});

	it("labels 付きの counter を記録できる", () => {
		const c = new PrometheusCollector();
		c.registerCounter("req_total", "requests");
		c.incrementCounter("req_total", { method: "GET" });
		c.incrementCounter("req_total", { method: "GET" });
		c.incrementCounter("req_total", { method: "POST" });
		const output = c.serialize();
		expect(output).toContain('req_total{method="GET"} 2');
		expect(output).toContain('req_total{method="POST"} 1');
	});

	it("labels がソートされる", () => {
		const c = new PrometheusCollector();
		c.registerCounter("multi_total", "multi label");
		c.incrementCounter("multi_total", { z: "1", a: "2" });
		const output = c.serialize();
		expect(output).toContain('multi_total{a="2",z="1"} 1');
	});

	it("未登録の counter は increment しても何も起きない", () => {
		const c = new PrometheusCollector();
		c.incrementCounter("unregistered_total");
		expect(c.serialize()).toBe("");
	});

	it("addCounter() で任意の値を加算できる", () => {
		const c = new PrometheusCollector();
		c.registerCounter("tokens_total", "token counter");
		c.addCounter("tokens_total", 150);
		c.addCounter("tokens_total", 200);
		const output = c.serialize();
		expect(output).toContain("tokens_total 350");
	});

	it("addCounter() で labels 付きの加算ができる", () => {
		const c = new PrometheusCollector();
		c.registerCounter("tokens_total", "token counter");
		c.addCounter("tokens_total", 100, { agent_type: "polling" });
		c.addCounter("tokens_total", 50, { agent_type: "polling" });
		c.addCounter("tokens_total", 200, { agent_type: "mention" });
		const output = c.serialize();
		expect(output).toContain('tokens_total{agent_type="polling"} 150');
		expect(output).toContain('tokens_total{agent_type="mention"} 200');
	});

	it("未登録の counter に addCounter しても何も起きない", () => {
		const c = new PrometheusCollector();
		c.addCounter("unregistered_total", 100);
		expect(c.serialize()).toBe("");
	});
});

// ─── Gauge ───────────────────────────────────────────────────────

describe("PrometheusCollector gauge", () => {
	it("set() で値を設定できる", () => {
		const c = new PrometheusCollector();
		c.registerGauge("temp", "temperature");
		c.setGauge("temp", 42);
		expect(c.serialize()).toContain("temp 42");
	});

	it("incrementGauge / decrementGauge で値が変動する", () => {
		const c = new PrometheusCollector();
		c.registerGauge("sessions", "active sessions");
		c.incrementGauge("sessions");
		c.incrementGauge("sessions");
		c.incrementGauge("sessions");
		c.decrementGauge("sessions");
		expect(c.serialize()).toContain("sessions 2");
	});

	it("labels 付きの gauge", () => {
		const c = new PrometheusCollector();
		c.registerGauge("conns", "connections");
		c.setGauge("conns", 10, { host: "a" });
		c.setGauge("conns", 20, { host: "b" });
		const output = c.serialize();
		expect(output).toContain('conns{host="a"} 10');
		expect(output).toContain('conns{host="b"} 20');
	});
});

// ─── Histogram ───────────────────────────────────────────────────

describe("PrometheusCollector histogram", () => {
	it("observe() で bucket, sum, count が正しく記録される", () => {
		const c = new PrometheusCollector();
		c.registerHistogram("duration", "request duration", [0.1, 0.5, 1.0]);
		c.observeHistogram("duration", 0.3);
		c.observeHistogram("duration", 0.8);
		c.observeHistogram("duration", 0.05);

		const output = c.serialize();

		// bucket: 0.1 には 0.05 のみ = 1
		expect(output).toContain('duration_bucket{le="0.1"} 1');
		// bucket: 0.5 には 0.05, 0.3 = 2
		expect(output).toContain('duration_bucket{le="0.5"} 2');
		// bucket: 1.0 には全て = 3
		expect(output).toContain('duration_bucket{le="1"} 3');
		// +Inf = count = 3
		expect(output).toContain('duration_bucket{le="+Inf"} 3');
		// sum = 0.3 + 0.8 + 0.05 = 1.15
		expect(output).toContain("duration_sum 1.15");
		// count = 3
		expect(output).toContain("duration_count 3");
	});

	it("labels 付きの histogram", () => {
		const c = new PrometheusCollector();
		c.registerHistogram("latency", "latency", [1, 5]);
		c.observeHistogram("latency", 2, { endpoint: "/api" });
		const output = c.serialize();
		expect(output).toContain('latency_bucket{endpoint="/api",le="1"} 0');
		expect(output).toContain('latency_bucket{endpoint="/api",le="5"} 1');
		expect(output).toContain('latency_bucket{endpoint="/api",le="+Inf"} 1');
	});
});

// ─── serialize 全体フォーマット ──────────────────────────────────

describe("PrometheusCollector serialize", () => {
	it("HELP と TYPE が出力される", () => {
		const c = new PrometheusCollector();
		c.registerCounter("foo_total", "A foo counter");
		c.incrementCounter("foo_total");
		const output = c.serialize();
		expect(output).toContain("# HELP foo_total A foo counter");
		expect(output).toContain("# TYPE foo_total counter");
	});

	it("メトリクスが未登録なら空文字を返す", () => {
		const c = new PrometheusCollector();
		expect(c.serialize()).toBe("");
	});

	it("複数のメトリクス種別が混在しても正しく出力される", () => {
		const c = new PrometheusCollector();
		c.registerCounter("cnt", "counter");
		c.registerGauge("gau", "gauge");
		c.registerHistogram("hist", "histogram", [1]);
		c.incrementCounter("cnt");
		c.setGauge("gau", 5);
		c.observeHistogram("hist", 0.5);

		const output = c.serialize();
		expect(output).toContain("# TYPE cnt counter");
		expect(output).toContain("cnt 1");
		expect(output).toContain("# TYPE gau gauge");
		expect(output).toContain("gau 5");
		expect(output).toContain("# TYPE hist histogram");
		expect(output).toContain('hist_bucket{le="1"} 1');
	});

	it("末尾が改行で終わる", () => {
		const c = new PrometheusCollector();
		c.registerCounter("x", "x");
		c.incrementCounter("x");
		const output = c.serialize();
		expect(output.endsWith("\n")).toBe(true);
	});
});

// ─── inferTrigger ────────────────────────────────────────────────

describe("inferTrigger", () => {
	it("heartbeat セッションキーを判定する", () => {
		expect(inferTrigger("system:heartbeat:guild-1")).toBe("heartbeat");
		expect(inferTrigger("system:heartbeat:_autonomous")).toBe("heartbeat");
	});

	it("home チャンネルセッションキーを判定する", () => {
		expect(inferTrigger("discord:123:_channel")).toBe("home");
	});

	it("メンションセッションキーを判定する", () => {
		expect(inferTrigger("discord:123:456")).toBe("mention");
	});
});
