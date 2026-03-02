import type { Logger } from "../../domain/ports/logger.port.ts";
import type { PrometheusCollector } from "./prometheus-collector.ts";

const DEFAULT_PORT = 9091;

export class PrometheusServer {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly port: number;

	constructor(
		private readonly collector: PrometheusCollector,
		private readonly logger: Logger,
	) {
		this.port = Number(process.env.METRICS_PORT) || DEFAULT_PORT;
	}

	start(): void {
		this.server = Bun.serve({
			port: this.port,
			fetch: (req) => this.handleRequest(req),
		});
		this.logger.info(`[metrics] Prometheus server listening on :${String(this.port)}`);
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
