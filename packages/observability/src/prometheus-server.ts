import type { Logger } from "@vicissitude/shared/types";

import type { PrometheusCollector } from "./prometheus-collector.ts";

// ─── Prometheus Server ──────────────────────────────────────────

export class PrometheusServer {
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- Bun.serve の戻り値型が any を含むため
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(
		private readonly collector: PrometheusCollector,
		private readonly logger: Logger,
		private readonly port: number,
		private readonly hostname: string = "0.0.0.0",
	) {}

	start(): void {
		this.server = Bun.serve({
			port: this.port,
			hostname: this.hostname,
			fetch: (req: Request) => this.handleRequest(req),
		});
		this.logger.info(
			`[metrics] Prometheus server listening on ${this.hostname}:${String(this.port)}`,
		);
	}

	stop(): void {
		if (this.server) {
			this.server.stop();
			this.server = null;
			this.logger.info("[metrics] Prometheus server stopped");
		}
	}

	private handleRequest(req: Request): Response {
		const url = new URL(req.url);

		if (url.pathname === "/metrics") {
			return new Response(this.collector.serialize(), {
				headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
			});
		}

		if (url.pathname === "/health") {
			return new Response("ok");
		}

		return new Response("Not Found", { status: 404 });
	}
}
