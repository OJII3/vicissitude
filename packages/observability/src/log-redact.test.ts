import { describe, expect, test } from "bun:test";

import { maskSecrets, redactObject } from "./log-redact.ts";

// ─── maskSecrets: 内部ロジック ──────────────────────────────────────

describe("maskSecrets - 内部ロジック", () => {
	// ─── 正規表現の優先順位 ─────────────────────────────────────
	describe("正規表現の優先順位", () => {
		test("sk- キーがメールパターンに誤マッチしない", () => {
			// sk- キーは API キーパターンで先にマスキングされ、
			// メールパターンで二重マッチしないことを確認
			const input = "sk-abcdefghij1234";
			const result = maskSecrets(input);
			expect(result).toBe("[REDACTED]");
			// メールパターンのみだと sk- キーはマッチしない
			const emailOnly = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g;
			expect(input.match(emailOnly)).toBeNull();
		});

		test("sk- キーの直後にメールが続く場合、両方が個別にマスキングされる", () => {
			const input = "sk-abcdefghij1234 user@example.com";
			const result = maskSecrets(input);
			expect(result).toBe("[REDACTED] [REDACTED]");
		});
	});

	// ─── replaceAll の g フラグ: 同一パターン複数出現 ────────────
	describe("同一パターンの複数出現がすべて置換される", () => {
		test("同一メールアドレスが複数回出現する場合すべて置換される", () => {
			const input = "from: a@b.com to: a@b.com cc: a@b.com";
			const result = maskSecrets(input);
			expect(result).toBe("from: [REDACTED] to: [REDACTED] cc: [REDACTED]");
		});

		test("異なる API キーが複数出現する場合すべて置換される", () => {
			const input = "keys: ghp_AAAAAAAAAA ghp_BBBBBBBBBB";
			const result = maskSecrets(input);
			expect(result).toBe("keys: [REDACTED] [REDACTED]");
		});

		test("同一電話番号が複数回出現する場合すべて置換される", () => {
			const input = "tel1: 090-1111-2222 tel2: 090-1111-2222";
			const result = maskSecrets(input);
			expect(result).toBe("tel1: [REDACTED] tel2: [REDACTED]");
		});
	});
});

// ─── redactObject: 内部ロジック ─────────────────────────────────────

describe("redactObject - 内部ロジック", () => {
	// ─── 循環参照ガード ─────────────────────────────────────────
	describe("循環参照ガード", () => {
		test("自己参照オブジェクトで無限再帰しない", () => {
			const obj: Record<string, unknown> = { name: "user@test.com" };
			obj.self = obj;

			const result = redactObject(obj) as Record<string, unknown>;
			expect(result.name).toBe("[REDACTED]");
			// 循環参照はセンチネル値に置換される
			expect(result.self).toBe("[circular]");
		});

		test("相互参照オブジェクトで無限再帰しない", () => {
			const a: Record<string, unknown> = { email: "a@test.com" };
			const b: Record<string, unknown> = { email: "b@test.com" };
			a.ref = b;
			b.ref = a;

			const result = redactObject(a) as Record<string, unknown>;
			expect(result.email).toBe("[REDACTED]");
			const bResult = result.ref as Record<string, unknown>;
			expect(bResult.email).toBe("[REDACTED]");
			// 循環参照先はセンチネル値（元データがリークしない）
			expect(bResult.ref).toBe("[circular]");
		});

		test("配列内の循環参照で無限再帰しない", () => {
			const arr: unknown[] = ["ghp_AAAAAAAAAA"];
			arr.push(arr);

			const result = redactObject(arr) as unknown[];
			expect(result[0]).toBe("[REDACTED]");
			expect(result[1]).toBe("[circular]");
		});
	});

	// ─── 深くネストしたオブジェクト ─────────────────────────────
	describe("深くネストしたオブジェクト", () => {
		test("5段以上ネストした文字列もマスキングされる", () => {
			const input = {
				l1: {
					l2: {
						l3: {
							l4: {
								l5: {
									l6: {
										secret: "sk-deep-nested-key-12345",
									},
								},
							},
						},
					},
				},
			};

			const result = redactObject(input) as typeof input;
			expect(result.l1.l2.l3.l4.l5.l6.secret).toBe("[REDACTED]");
		});

		test("深いネスト内の配列もマスキングされる", () => {
			const input = {
				a: { b: { c: { d: { e: ["user@deep.com", "safe"] } } } },
			};

			const result = redactObject(input) as typeof input;
			expect(result.a.b.c.d.e[0]).toBe("[REDACTED]");
			expect(result.a.b.c.d.e[1]).toBe("safe");
		});
	});

	// ─── 空オブジェクト / 空配列 ────────────────────────────────
	describe("空オブジェクト / 空配列", () => {
		test("空オブジェクトはコピーされて返る", () => {
			const input = {};
			const result = redactObject(input);
			expect(result).toEqual({});
			// 別オブジェクトであること
			expect(result).not.toBe(input);
		});

		test("空配列はコピーされて返る", () => {
			const input: unknown[] = [];
			const result = redactObject(input);
			expect(result).toEqual([]);
			// 別配列であること
			expect(result).not.toBe(input);
		});
	});

	// ─── undefined 値 ───────────────────────────────────────────
	describe("undefined 値", () => {
		test("値が undefined のプロパティはそのまま保持される", () => {
			const input = { key: undefined, name: "normal" };
			const result = redactObject(input) as Record<string, unknown>;
			expect(result.key).toBeUndefined();
			expect(result.name).toBe("normal");
		});

		test("undefined を直接渡した場合はそのまま返る", () => {
			const undef: unknown = void 0;
			expect(redactObject(undef)).toBeUndefined();
		});
	});
});
