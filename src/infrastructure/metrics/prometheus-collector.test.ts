import { describe, expect, it } from "bun:test";

import { PrometheusCollector } from "./prometheus-collector.ts";

describe("PrometheusCollector", () => {
	describe("Counter", () => {
		it("should increment counter without labels", () => {
			const c = new PrometheusCollector();
			c.registerCounter("test_total", "A test counter");
			c.incrementCounter("test_total");
			c.incrementCounter("test_total");

			const output = c.serialize();
			expect(output).toContain("# HELP test_total A test counter");
			expect(output).toContain("# TYPE test_total counter");
			expect(output).toContain("test_total 2");
		});

		it("should increment counter with labels", () => {
			const c = new PrometheusCollector();
			c.registerCounter("requests_total", "Total requests");
			c.incrementCounter("requests_total", { method: "GET" });
			c.incrementCounter("requests_total", { method: "GET" });
			c.incrementCounter("requests_total", { method: "POST" });

			const output = c.serialize();
			expect(output).toContain('requests_total{method="GET"} 2');
			expect(output).toContain('requests_total{method="POST"} 1');
		});

		it("should sort label keys alphabetically", () => {
			const c = new PrometheusCollector();
			c.registerCounter("multi_label", "Multi label counter");
			c.incrementCounter("multi_label", { z: "1", a: "2" });

			const output = c.serialize();
			expect(output).toContain('multi_label{a="2",z="1"} 1');
		});

		it("should ignore increment for unregistered counter", () => {
			const c = new PrometheusCollector();
			c.incrementCounter("unregistered_total");
			expect(c.serialize()).toBe("");
		});
	});

	describe("Gauge", () => {
		it("should set gauge value", () => {
			const c = new PrometheusCollector();
			c.registerGauge("temperature", "Current temperature");
			c.setGauge("temperature", 42);

			const output = c.serialize();
			expect(output).toContain("# TYPE temperature gauge");
			expect(output).toContain("temperature 42");
		});

		it("should overwrite gauge value", () => {
			const c = new PrometheusCollector();
			c.registerGauge("connections", "Active connections");
			c.setGauge("connections", 5);
			c.setGauge("connections", 3);

			const output = c.serialize();
			expect(output).toContain("connections 3");
			expect(output).not.toContain("connections 5");
		});

		it("should support gauge with labels", () => {
			const c = new PrometheusCollector();
			c.registerGauge("bot_info", "Bot information");
			c.setGauge("bot_info", 1, { bot_name: "fua" });

			const output = c.serialize();
			expect(output).toContain('bot_info{bot_name="fua"} 1');
		});
	});

	describe("Histogram", () => {
		it("should observe values and produce bucket output", () => {
			const c = new PrometheusCollector();
			c.registerHistogram("duration_seconds", "Request duration", [0.1, 0.5, 1, 5]);

			c.observeHistogram("duration_seconds", 0.05);
			c.observeHistogram("duration_seconds", 0.3);
			c.observeHistogram("duration_seconds", 2);
			c.observeHistogram("duration_seconds", 10);

			const output = c.serialize();
			expect(output).toContain("# TYPE duration_seconds histogram");
			expect(output).toContain('duration_seconds_bucket{le="0.1"} 1');
			expect(output).toContain('duration_seconds_bucket{le="0.5"} 2');
			expect(output).toContain('duration_seconds_bucket{le="1"} 2');
			expect(output).toContain('duration_seconds_bucket{le="5"} 3');
			expect(output).toContain('duration_seconds_bucket{le="+Inf"} 4');
			expect(output).toContain("duration_seconds_sum 12.35");
			expect(output).toContain("duration_seconds_count 4");
		});

		it("should use default buckets when none specified", () => {
			const c = new PrometheusCollector();
			c.registerHistogram("default_hist", "Default histogram");
			c.observeHistogram("default_hist", 0.05);

			const output = c.serialize();
			expect(output).toContain('default_hist_bucket{le="0.1"} 1');
			expect(output).toContain('default_hist_bucket{le="120"} 1');
			expect(output).toContain('default_hist_bucket{le="+Inf"} 1');
		});
	});

	describe("serialize", () => {
		it("should return empty string when no metrics registered", () => {
			const c = new PrometheusCollector();
			expect(c.serialize()).toBe("");
		});

		it("should output all metric types in registration order", () => {
			const c = new PrometheusCollector();
			c.registerCounter("c_total", "Counter");
			c.registerGauge("g_value", "Gauge");
			c.registerHistogram("h_seconds", "Histogram", [1]);

			c.incrementCounter("c_total");
			c.setGauge("g_value", 1);
			c.observeHistogram("h_seconds", 0.5);

			const output = c.serialize();
			const cIdx = output.indexOf("# TYPE c_total");
			const gIdx = output.indexOf("# TYPE g_value");
			const hIdx = output.indexOf("# TYPE h_seconds");

			expect(cIdx).toBeLessThan(gIdx);
			expect(gIdx).toBeLessThan(hIdx);
		});

		it("should end with newline when metrics exist", () => {
			const c = new PrometheusCollector();
			c.registerCounter("test_total", "Test");
			c.incrementCounter("test_total");

			const output = c.serialize();
			expect(output.endsWith("\n")).toBe(true);
		});
	});
});
