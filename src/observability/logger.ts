import pino, { type DestinationStream, type Logger } from "pino";

const secretKeys = new Set(["discordtoken", "databaseurl", "apikey", "authorization"]);
const keyName = (key: string) => key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
function sanitizeString(value: string): string {
  const redacted = value
    .replaceAll(/authorization\s*[:=][^\r\n]+/giu, "authorization: [REDACTED]")
    .replaceAll(/((?:token|api[_-]?key|discord[_-]?token|database[_-]?url)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replaceAll(/postgres(?:ql)?:\/\/[^\s"'<>|]+/giu, "[REDACTED]");
  return Array.from(redacted, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f ? "?" : character;
  }).join("");
}
function sanitize(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
      ...(value.stack === undefined ? {} : { stack: sanitizeString(value.stack) }),
    };
  }
  const prior = seen.get(value);
  if (prior !== undefined) return "[Circular]";
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(sanitize(item, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value))
    result[key] = secretKeys.has(keyName(key)) ? "[REDACTED]" : sanitize(item, seen);
  return result;
}
export function createLogger(options: { level: string; destination?: DestinationStream }): Logger {
  const logger = pino(
    {
      level: options.level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: {
        logMethod(input, method) {
          for (let index = 0; index < input.length; index++) input[index] = sanitize(input[index]);
          method.apply(this, input);
        },
      },
    },
    options.destination,
  );
  const wrapChild = (parent: Logger): Logger => {
    const child = parent.child.bind(parent);
    parent.child = ((bindings: Parameters<Logger["child"]>[0], childOptions?: Parameters<Logger["child"]>[1]) => {
      const sanitized = sanitize(bindings) as object;
      return wrapChild(
        (childOptions === undefined ? child(sanitized) : child(sanitized, childOptions)) as unknown as Logger,
      );
    }) as unknown as Logger["child"];
    return parent;
  };
  return wrapChild(logger);
}
