import type { Logger } from "@vicissitude/shared/types";
import pino from "pino";

export class ConsoleLogger implements Logger {
	private readonly pino: pino.Logger;

	constructor(level: string = process.env.LOG_LEVEL ?? "info") {
		this.pino = pino({ level });
	}

	debug(message: string, ...args: unknown[]): void {
		if (args.length > 0) {
			this.pino.debug({ extra: args.length === 1 ? args[0] : args }, message);
		} else {
			this.pino.debug(message);
		}
	}

	info(message: string, ...args: unknown[]): void {
		if (args.length > 0) {
			this.pino.info({ extra: args.length === 1 ? args[0] : args }, message);
		} else {
			this.pino.info(message);
		}
	}

	error(message: string, ...args: unknown[]): void {
		if (args.length > 0) {
			this.pino.error({ extra: args.length === 1 ? args[0] : args }, message);
		} else {
			this.pino.error(message);
		}
	}

	warn(message: string, ...args: unknown[]): void {
		if (args.length > 0) {
			this.pino.warn({ extra: args.length === 1 ? args[0] : args }, message);
		} else {
			this.pino.warn(message);
		}
	}
}
