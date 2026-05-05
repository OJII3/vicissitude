import type { Schema } from "./llm-port.ts";
import type { ConsolidationAction, FactCategory } from "./types.ts";
import { CONSOLIDATION_ACTIONS, FACT_CATEGORIES } from "./types.ts";

export interface ExtractedFact {
	action: ConsolidationAction;
	category: FactCategory;
	fact: string;
	keywords: string[];
	existingFactId?: string;
}

export interface ConsolidationOutput {
	facts: ExtractedFact[];
}

const MAX_FACTS_PER_EPISODE = 30;
const MAX_KEYWORDS_PER_FACT = 10;
const MAX_FACT_LENGTH = 1000;
const MAX_KEYWORD_LENGTH = 100;
const VALID_ACTIONS = new Set<string>(CONSOLIDATION_ACTIONS);
const VALID_CATEGORIES = new Set<string>(FACT_CATEGORIES);

function validateFactFields(obj: Record<string, unknown>, i: number): void {
	if (typeof obj["action"] !== "string" || !VALID_ACTIONS.has(obj["action"])) {
		throw new TypeError(`facts[${i}].action: expected one of ${[...VALID_ACTIONS].join(", ")}`);
	}
	if (typeof obj["category"] !== "string" || !VALID_CATEGORIES.has(obj["category"])) {
		throw new TypeError(
			`facts[${i}].category: expected one of ${[...VALID_CATEGORIES].join(", ")}`,
		);
	}
	if (typeof obj["fact"] !== "string" || obj["fact"] === "") {
		throw new TypeError(`facts[${i}].fact: expected non-empty string`);
	}
	if (obj["fact"].length > MAX_FACT_LENGTH) {
		throw new RangeError(`facts[${i}].fact: too long (${obj["fact"].length} > ${MAX_FACT_LENGTH})`);
	}
}

function validateKeywords(obj: Record<string, unknown>, i: number): void {
	if (!Array.isArray(obj["keywords"])) {
		throw new TypeError(`facts[${i}].keywords: expected array`);
	}
	const keywords = obj["keywords"] as unknown[];
	if (keywords.length > MAX_KEYWORDS_PER_FACT) {
		throw new RangeError(
			`facts[${i}].keywords: too many keywords (${keywords.length}), maximum ${MAX_KEYWORDS_PER_FACT}`,
		);
	}
	for (let k = 0; k < keywords.length; k++) {
		if (typeof keywords[k] !== "string") {
			throw new TypeError(`facts[${i}].keywords[${k}]: expected string`);
		}
		if ((keywords[k] as string).length > MAX_KEYWORD_LENGTH) {
			throw new RangeError(
				`facts[${i}].keywords[${k}]: too long (${(keywords[k] as string).length} > ${MAX_KEYWORD_LENGTH})`,
			);
		}
	}
}

function validateExistingFactId(obj: Record<string, unknown>, i: number): void {
	const action = obj["action"] as ConsolidationAction;
	const needsExistingId = action === "reinforce" || action === "update" || action === "invalidate";
	if (needsExistingId && typeof obj["existingFactId"] !== "string") {
		throw new TypeError(`facts[${i}].existingFactId: required for action "${action}"`);
	}
}

function validateExtractedFact(f: unknown, i: number): ExtractedFact {
	if (typeof f !== "object" || f === null) {
		throw new TypeError(`facts[${i}]: expected object`);
	}
	const obj = f as Record<string, unknown>;
	validateFactFields(obj, i);
	validateKeywords(obj, i);
	validateExistingFactId(obj, i);
	return {
		action: obj["action"] as ConsolidationAction,
		category: obj["category"] as FactCategory,
		fact: obj["fact"] as string,
		keywords: obj["keywords"] as string[],
		existingFactId: typeof obj["existingFactId"] === "string" ? obj["existingFactId"] : undefined,
	};
}

export const consolidationSchema: Schema<ConsolidationOutput> = {
	parse(data: unknown): ConsolidationOutput {
		if (typeof data !== "object" || data === null) {
			throw new TypeError("Expected object");
		}
		const obj = data as Record<string, unknown>;
		if (!Array.isArray(obj["facts"])) {
			throw new TypeError("Expected facts array");
		}
		const raw = obj["facts"] as unknown[];
		if (raw.length > MAX_FACTS_PER_EPISODE) {
			throw new RangeError(
				`facts: too many facts (${raw.length}), maximum ${MAX_FACTS_PER_EPISODE}`,
			);
		}
		return { facts: raw.map((f, i) => validateExtractedFact(f, i)) };
	},
};
