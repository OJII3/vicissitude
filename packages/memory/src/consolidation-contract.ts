import { z } from "zod";

import type { Schema } from "./llm-port.ts";
import { FACT_CATEGORIES } from "./types.ts";
import type { FactCategory } from "./types.ts";

export interface BaseExtractedFact {
	category: FactCategory;
	fact: string;
	keywords: string[];
}

export interface NewExtractedFact extends BaseExtractedFact {
	action: "new";
	existingFactId?: never;
}

export interface ReinforceExtractedFact extends BaseExtractedFact {
	action: "reinforce";
	existingFactId: string;
}

export interface UpdateExtractedFact extends BaseExtractedFact {
	action: "update";
	existingFactId: string;
}

export interface InvalidateExtractedFact extends BaseExtractedFact {
	action: "invalidate";
	existingFactId: string;
}

export type ExistingExtractedFact =
	| ReinforceExtractedFact
	| UpdateExtractedFact
	| InvalidateExtractedFact;

export type ExtractedFact = NewExtractedFact | ExistingExtractedFact;

export interface ConsolidationOutput {
	facts: ExtractedFact[];
}

const MAX_FACTS_PER_EPISODE = 30;
const MAX_KEYWORDS_PER_FACT = 10;
const MAX_FACT_LENGTH = 1000;
const MAX_KEYWORD_LENGTH = 100;

const keywordsSchema = z
	.union(
		[
			z.string().transform((s) =>
				s
					.split(",")
					.map((k) => k.trim())
					.filter((k) => k !== ""),
			),
			z.array(
				z
					.string({ error: (i) => `keywords[${String(i.path?.[0] ?? 0)}]: expected string` })
					.max(MAX_KEYWORD_LENGTH),
			),
		],
		{ error: () => "keywords: expected array or string" },
	)
	.pipe(
		z
			.array(z.string().max(MAX_KEYWORD_LENGTH))
			.max(MAX_KEYWORDS_PER_FACT, { error: () => "keywords: too many keywords" }),
	);

const baseFactFields = {
	category: z.enum([...FACT_CATEGORIES] as [string, ...string[]], {
		error: () => "category: invalid value",
	}),
	fact: z
		.string()
		.min(1, { error: () => "fact: expected non-empty string" })
		.max(MAX_FACT_LENGTH),
	keywords: keywordsSchema,
};

const extractedFactSchema = z.discriminatedUnion(
	"action",
	[
		z.object({ action: z.literal("new"), ...baseFactFields }),
		z.object({
			action: z.literal("reinforce"),
			existingFactId: z.string({ error: () => 'existingFactId: required for action "reinforce"' }),
			...baseFactFields,
		}),
		z.object({
			action: z.literal("update"),
			existingFactId: z.string({ error: () => 'existingFactId: required for action "update"' }),
			...baseFactFields,
		}),
		z.object({
			action: z.literal("invalidate"),
			existingFactId: z.string({ error: () => 'existingFactId: required for action "invalidate"' }),
			...baseFactFields,
		}),
	],
	{ error: () => "action: invalid discriminator" },
);

const factsElementSchema = z
	.any()
	.superRefine((val, ctx) => {
		if (typeof val !== "object" || val === null) {
			ctx.addIssue({
				code: "custom",
				message: `expected object, received ${val === null ? "null" : typeof val}`,
			});
			return z.NEVER;
		}
	})
	.pipe(extractedFactSchema);

export const consolidationSchema: Schema<ConsolidationOutput> = z.preprocess(
	(data) => {
		if (typeof data !== "object" || data === null) {
			throw new TypeError("Expected object");
		}
		const obj = data as Record<string, unknown>;
		if (!Array.isArray(obj["facts"])) {
			throw new TypeError("Expected facts array");
		}
		return data;
	},
	z.object({
		facts: z.array(factsElementSchema).max(MAX_FACTS_PER_EPISODE),
	}),
) as Schema<ConsolidationOutput>;
