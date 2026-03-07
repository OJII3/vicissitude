import type { Logger } from "./domain/ports/logger.port.ts";
import type { FileContextLoaderFactory } from "./infrastructure/context/file-context-loader-factory.ts";
import type { JsonChannelConfigLoader } from "./infrastructure/context/json-channel-config-loader.ts";
import type { DiscordGateway } from "./infrastructure/discord/discord-gateway.ts";
import type { FenghuangFactReader } from "./infrastructure/fenghuang/fenghuang-fact-reader.ts";
import type { PrometheusCollector } from "./infrastructure/metrics/prometheus-collector.ts";
import type { PrometheusServer } from "./infrastructure/metrics/prometheus-server.ts";
import type { JsonSessionRepository } from "./infrastructure/persistence/json-session-repository.ts";

export interface BootstrapContext {
	root: string;
	sessions: JsonSessionRepository;
	contextLoaderFactory: FileContextLoaderFactory;
	gateway: DiscordGateway;
	channelConfig: JsonChannelConfigLoader;
	logger: Logger;
	metrics: PrometheusCollector;
	metricsServer: PrometheusServer;
	ltmFactReader?: FenghuangFactReader;
}
