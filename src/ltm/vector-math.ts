function dotAndNorms(a: number[], b: number[]): { dot: number; normA: number; normB: number } {
	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		dot += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}
	return { dot, normA, normB };
}

/** Compute cosine similarity between two vectors. Returns 0.0 for zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
	}

	const { dot, normA, normB } = dotAndNorms(a, b);
	if (normA === 0 || normB === 0) {
		return 0.0;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
