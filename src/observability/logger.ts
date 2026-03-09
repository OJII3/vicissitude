import type { Logger } from "../core/types.ts";

type LogLevel = "info" | "warn" | "error";

const COMPONENT_RE = /^\[([^\]]+)\]\s*/;

function serializeArg(arg: unknown): unknown {
	if (arg instanceof Error) {
		return { name: arg.name, message: arg.message, stack: arg.stack };
	}
	return arg;
}

function buildEntry(level: LogLevel, message: string, args: unknown[]): string {
	const entry: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level,
	};

	const match = COMPONENT_RE.exec(message);
	if (match) {
		entry.component = match[1];
		entry.message = message.slice(match[0].length);
	} else {
		entry.message = message;
	}

	if (args.length === 1) {
		entry.extra = serializeArg(args[0]);
	} else if (args.length > 1) {
		entry.extra = args.map((a) => serializeArg(a));
	}

	try {
		return `${JSON.stringify(entry)}\n`;
	} catch {
		return `${JSON.stringify({ timestamp: entry.timestamp, level, message, error: "Failed to serialize log entry" })}\n`;
	}
}

export class ConsoleLogger implements Logger {
	info(message: string, ...args: unknown[]): void {
		process.stdout.write(buildEntry("info", message, args));
	}

	error(message: string, ...args: unknown[]): void {
		process.stderr.write(buildEntry("error", message, args));
	}

	warn(message: string, ...args: unknown[]): void {
		process.stderr.write(buildEntry("warn", message, args));
	}
}
