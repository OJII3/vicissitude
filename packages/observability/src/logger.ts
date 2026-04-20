import type { Logger } from "@vicissitude/shared/types";
import pino from "pino";

export class ConsoleLogger implements Logger {
	// oxlint-disable-next-line typescript/no-explicit-any -- pino の child() が返す型パラメータが親と異なるため any で統一
	private readonly pino: pino.Logger<any>;

	/**
	 * @param options — 設定オブジェクト。
	 *   stdio MCP サーバーでは stdout が MCP 通信に使われるため `{ destination: "stderr" }` を指定する。
	 */
	constructor(options?: { level?: string; destination?: "stderr" });
	/** @internal 既存の pino インスタンスをラップする（child() 用） */
	// oxlint-disable-next-line typescript/no-explicit-any
	constructor(existingPino: pino.Logger<any>);
	// oxlint-disable-next-line typescript/no-explicit-any
	constructor(arg?: { level?: string; destination?: "stderr" } | pino.Logger<any>) {
		if (arg && "child" in arg && typeof arg.child === "function") {
			this.pino = arg;
		} else {
			const opts = arg ?? {};
			const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
			this.pino = pino({ level }, opts.destination === "stderr" ? pino.destination(2) : undefined);
		}
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

	child(bindings: Record<string, unknown>): ConsoleLogger {
		return new ConsoleLogger(this.pino.child(bindings));
	}

	private log(level: pino.Level, message: string, args: unknown[]): void {
		if (args.length > 0) {
			this.pino[level]({ extra: args.length === 1 ? args[0] : args }, message);
		} else {
			this.pino[level](message);
		}
	}
}
