import type { Logger } from "@vicissitude/shared/types";
import pino from "pino";

export class ConsoleLogger implements Logger {
	private readonly pino: pino.Logger;

	constructor(level: string = process.env.LOG_LEVEL ?? "info") {
		this.pino = pino({ level });
	}

	debug(message: string, ...args: unknown[]): void {
		this.log("debug", message, args);
	}

	info(message: string, ...args: unknown[]): void {
		this.log("info", message, args);
	}

	error(message: string, ...args: unknown[]): void {
		this.log("error", message, args);
	}

	warn(message: string, ...args: unknown[]): void {
		this.log("warn", message, args);
	}

	private log(level: pino.Level, message: string, args: unknown[]): void {
		if (args.length > 0) {
			this.pino[level]({ extra: args.length === 1 ? args[0] : args }, message);
		} else {
			this.pino[level](message);
		}
	}
}
