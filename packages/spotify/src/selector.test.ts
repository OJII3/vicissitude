import { describe, expect, it } from "bun:test";

import { createTrackSelector } from "./selector.ts";
import type { SpotifyTrack } from "./types.ts";

function createTrack(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
	return {
		id: overrides.id ?? "t1",
		name: overrides.name ?? "Song",
		artistName: overrides.artistName ?? "Artist",
		artistId: overrides.artistId ?? "a1",
		albumName: overrides.albumName ?? "Album",
		genres: overrides.genres ?? [],
		popularity: overrides.popularity ?? 50,
		releaseDate: overrides.releaseDate ?? "2024-01-01",
		albumArtUrl: overrides.albumArtUrl ?? "https://example.com/art.jpg",
	};
}

describe("selector – 重み計算", () => {
	it("popularity=0 の曲でも最低重み 1 が付与される", () => {
		const selector = createTrackSelector();
		const track = createTrack({ id: "zero", popularity: 0 });

		// popularity=0 でも select から返されることを確認（重み=1 なので必ず選ばれる）
		const result = selector.select([track]);
		expect(result).not.toBeNull();
		expect(result?.id).toBe("zero");
	});

	it("popularity が負の値でも Math.max により重み 1 が適用される", () => {
		const selector = createTrackSelector();
		const track = createTrack({ id: "neg", popularity: -10 });

		const result = selector.select([track]);
		expect(result).not.toBeNull();
		expect(result?.id).toBe("neg");
	});

	it("重みは Math.max(popularity, 1) で計算される", () => {
		// popularity=0 → weight=1, popularity=50 → weight=50
		// 比率は 1:50 なので、popularity=50 の曲が圧倒的に多く選ばれるはず
		const selector = createTrackSelector();
		const zeroTrack = createTrack({ id: "zero", popularity: 0 });
		const fiftyTrack = createTrack({ id: "fifty", popularity: 50 });

		const counts = { zero: 0, fifty: 0 };
		for (let i = 0; i < 5000; i++) {
			const result = selector.select([zeroTrack, fiftyTrack]);
			if (result?.id === "zero") counts.zero++;
			if (result?.id === "fifty") counts.fifty++;
		}

		// weight ratio is 1:50, so fifty should be selected ~98% of the time
		expect(counts.fifty).toBeGreaterThan(counts.zero * 10);
	});
});

describe("selector – 均等分布", () => {
	it("全曲同じ popularity の場合、均等に近い分布になる", () => {
		const selector = createTrackSelector();
		const tracks = Array.from({ length: 5 }, (_, i) =>
			createTrack({ id: `t${i}`, popularity: 50 }),
		);

		const counts = new Map<string, number>();
		for (const t of tracks) counts.set(t.id, 0);

		const iterations = 10000;
		for (let i = 0; i < iterations; i++) {
			const result = selector.select(tracks);
			if (result) counts.set(result.id, (counts.get(result.id) ?? 0) + 1);
		}

		// each track should appear ~2000 times (10000 / 5)
		const expected = iterations / tracks.length;
		for (const t of tracks) {
			const count = counts.get(t.id) ?? 0;
			// 各曲は期待値の半分以上、2倍以下に収まるべき
			expect(count).toBeGreaterThan(expected * 0.5);
			expect(count).toBeLessThan(expected * 2);
		}
	});
});

describe("selector – 大量データ", () => {
	it("1000 曲のリストでも正しく 1 曲を選択する", () => {
		const selector = createTrackSelector();
		const tracks = Array.from({ length: 1000 }, (_, i) =>
			createTrack({ id: `t${i}`, popularity: i % 100 }),
		);

		const result = selector.select(tracks);
		expect(result).not.toBeNull();
		expect(tracks.some((t) => t.id === result?.id)).toBe(true);
	});

	it("10000 曲のリストでもパフォーマンスに問題がない", () => {
		const selector = createTrackSelector();
		const tracks = Array.from({ length: 10000 }, (_, i) =>
			createTrack({ id: `t${i}`, popularity: (i % 100) + 1 }),
		);

		const start = performance.now();
		for (let i = 0; i < 100; i++) {
			selector.select(tracks);
		}
		const elapsed = performance.now() - start;

		// 100 回の選択が 1 秒以内に完了すべき
		expect(elapsed).toBeLessThan(1000);
	});
});

describe("selector – フォールバック", () => {
	it("ループで選択されなかった場合、最後の曲が返される", () => {
		// totalWeight と random がちょうど等しい場合のエッジケース
		// tracks.at(-1) がフォールバックとして返される
		const selector = createTrackSelector();
		const tracks = [
			createTrack({ id: "a", popularity: 1 }),
			createTrack({ id: "b", popularity: 1 }),
		];

		// 1000 回実行して常にリスト内の曲が返されることを確認
		for (let i = 0; i < 1000; i++) {
			const result = selector.select(tracks);
			expect(result).not.toBeNull();
			expect(["a", "b"]).toContain(result?.id ?? "");
		}
	});
});
