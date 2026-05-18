export interface EmotionPromptErrorInfo {
	status?: number;
	retryable?: boolean;
	retryAfterSeconds?: number;
	errorClass: string;
	reason: string;
	message?: string;
}

export function extractEmotionPromptErrorInfo(error: unknown): EmotionPromptErrorInfo {
	const nodes = collectErrorNodes(error);
	const messages = collectMessages(nodes);
	const status =
		findNumberField(nodes, ["status", "statusCode", "status_code", "httpStatus"]) ??
		parseStatusFromMessages(messages);
	const retryAfterSeconds = findRetryAfterSeconds(nodes, messages);
	const retryable = findBooleanField(nodes, ["retryable", "isRetryable", "is_retryable"]);
	const errorClass =
		findStringField(nodes, ["name", "errorClass", "error_class"]) ?? errorClassOf(error);
	const reason = findReason(nodes, messages, status);
	const message = messages.length > 0 ? messages.join(" | ").slice(0, 500) : undefined;
	return { status, retryable, retryAfterSeconds, errorClass, reason, message };
}

function collectErrorNodes(value: unknown, seen = new Set<unknown>(), depth = 0): unknown[] {
	if (value === null || value === undefined || depth > 5 || seen.has(value)) return [];
	if (typeof value === "object" || typeof value === "function") {
		seen.add(value);
	}
	const nodes: unknown[] = [value];
	if (value instanceof Error) {
		nodes.push(...parseEmbeddedJson(value.message));
		if (value.cause !== undefined) {
			nodes.push(...collectErrorNodes(value.cause, seen, depth + 1));
		}
	}
	if (!isRecord(value)) return nodes;

	for (const key of ["cause", "error", "response", "body", "data", "result", "details"]) {
		if (key in value) {
			nodes.push(...collectErrorNodes(value[key], seen, depth + 1));
		}
	}
	const message = value.message;
	if (typeof message === "string") {
		nodes.push(...parseEmbeddedJson(message));
	}
	return nodes;
}

function collectMessages(nodes: unknown[]): string[] {
	const messages: string[] = [];
	for (const node of nodes) {
		if (node instanceof Error && node.message) messages.push(node.message);
		if (isRecord(node) && typeof node.message === "string") messages.push(node.message);
		if (typeof node === "string") messages.push(node);
	}
	return [...new Set(messages)];
}

function parseEmbeddedJson(text: string): unknown[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return [];
	try {
		return [JSON.parse(text.slice(start, end + 1))];
	} catch {
		return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function findNumberField(nodes: unknown[], keys: string[]): number | undefined {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		for (const [key, value] of Object.entries(node)) {
			if (!keySet.has(key.toLowerCase())) continue;
			const numberValue = parseFiniteNumber(value);
			if (numberValue !== undefined) return numberValue;
		}
	}
}

function findBooleanField(nodes: unknown[], keys: string[]): boolean | undefined {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		for (const [key, value] of Object.entries(node)) {
			if (!keySet.has(key.toLowerCase())) continue;
			if (typeof value === "boolean") return value;
			if (value === "true") return true;
			if (value === "false") return false;
		}
	}
}

function findStringField(nodes: unknown[], keys: string[]): string | undefined {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		for (const [key, value] of Object.entries(node)) {
			if (!keySet.has(key.toLowerCase())) continue;
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
}

function parseFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
}

function parseStatusFromMessages(messages: string[]): number | undefined {
	for (const message of messages) {
		const match =
			/"status(?:Code)?"\s*:\s*(\d{3})/i.exec(message) ??
			/status(?:Code)?[=\s:]+(\d{3})/i.exec(message) ??
			/status code[=\s:]+(\d{3})/i.exec(message);
		if (match?.[1]) return Number(match[1]);
	}
}

function findRetryAfterSeconds(nodes: unknown[], messages: string[]): number | undefined {
	const retryAfterMs = findNumberField(nodes, ["retryAfterMs", "retry_after_ms"]);
	if (retryAfterMs !== undefined) return Math.ceil(retryAfterMs / 1000);

	const headerValue =
		findHeaderValue(nodes, "x-ratelimit-user-retry-after") ?? findHeaderValue(nodes, "retry-after");
	const headerSeconds = parseRetryAfterValue(headerValue);
	if (headerSeconds !== undefined) return headerSeconds;

	const fieldValue = findFieldValue(nodes, [
		"retryAfter",
		"retry_after",
		"retryAfterSeconds",
		"retry_after_seconds",
	]);
	const fieldSeconds = parseRetryAfterValue(fieldValue);
	if (fieldSeconds !== undefined) return fieldSeconds;

	for (const message of messages) {
		const match = /(?:x-ratelimit-user-retry-after|retry-after|retryAfter)[^0-9]{0,30}(\d+)/i.exec(
			message,
		);
		if (match?.[1]) return Number(match[1]);
	}
}

function findFieldValue(nodes: unknown[], keys: string[]): unknown {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		for (const [key, value] of Object.entries(node)) {
			if (keySet.has(key.toLowerCase())) return value;
		}
	}
}

function parseRetryAfterValue(value: unknown): number | undefined {
	if (value === undefined) return;
	const numberValue = parseFiniteNumber(value);
	if (numberValue !== undefined) return Math.max(0, Math.ceil(numberValue));
	if (typeof value !== "string") return;
	const parsedDate = Date.parse(value);
	if (!Number.isFinite(parsedDate)) return;
	return Math.max(0, Math.ceil((parsedDate - Date.now()) / 1000));
}

function findHeaderValue(nodes: unknown[], name: string): unknown {
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		for (const key of ["headers", "responseHeaders", "response_headers"]) {
			if (key in node) {
				const value = readHeader(node[key], name);
				if (value !== undefined) return value;
			}
		}
		const value = readHeader(node, name);
		if (value !== undefined) return value;
	}
}

function readHeader(headers: unknown, name: string): unknown {
	if (!headers) return;
	const lowerName = name.toLowerCase();
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (headers instanceof Map) {
		for (const [key, value] of headers) {
			if (String(key).toLowerCase() === lowerName) return value;
		}
		return;
	}
	if (typeof headers === "object" && "get" in headers && typeof headers.get === "function") {
		const value = headers.get(name);
		if (value !== null && value !== undefined) return value;
	}
	if (!isRecord(headers)) return;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return value;
	}
}

function findReason(nodes: unknown[], messages: string[], status: number | undefined): string {
	const headerReason = findHeaderValue(nodes, "x-ratelimit-exceeded");
	if (typeof headerReason === "string" && headerReason.trim()) return headerReason.trim();
	const fieldReason = findStringField(nodes, [
		"reason",
		"code",
		"errorCode",
		"error_code",
		"type",
		"x-ratelimit-exceeded",
	]);
	if (fieldReason) return fieldReason;
	if (messages.some((message) => message.includes("quota_exceeded"))) return "quota_exceeded";
	if (status === 429) return "rate_limited";
	return "unknown";
}

function errorClassOf(error: unknown): string {
	if (error instanceof Error && error.name) return error.name;
	if (isRecord(error) && typeof error.name === "string" && error.name.trim()) {
		return error.name.trim();
	}
	if (typeof error === "object" && error !== null && "constructor" in error) {
		const ctor = error.constructor as { name?: string };
		if (ctor.name) return ctor.name;
	}
	return "unknown";
}
