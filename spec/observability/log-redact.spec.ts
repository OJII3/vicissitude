import { describe, expect, it } from "bun:test";

import { maskSecrets, redactObject } from "@vicissitude/observability/log-redact";

// ─── maskSecrets ────────────────────────────────────────────────────

describe("maskSecrets", () => {
	// ─── メールアドレス ─────────────────────────────────────────

	describe("メールアドレスのマスキング", () => {
		it("メールアドレスが [REDACTED] に置換される", () => {
			expect(maskSecrets("contact user@example.com please")).toBe("contact [REDACTED] please");
		});

		it("サブドメイン付きメールアドレスもマスキングされる", () => {
			expect(maskSecrets("send to admin@mail.corp.co.jp")).toBe("send to [REDACTED]");
		});
	});

	// ─── 日本の電話番号 ─────────────────────────────────────────

	describe("日本の電話番号のマスキング", () => {
		it("ハイフン付き携帯番号がマスキングされる", () => {
			expect(maskSecrets("tel: 090-1234-5678")).toBe("tel: [REDACTED]");
		});

		it("ハイフンなし携帯番号がマスキングされる", () => {
			expect(maskSecrets("tel: 09012345678")).toBe("tel: [REDACTED]");
		});

		it("080 で始まる番号もマスキングされる", () => {
			expect(maskSecrets("080-9876-5432")).toBe("[REDACTED]");
		});

		it("070 で始まる番号もマスキングされる", () => {
			expect(maskSecrets("070-1111-2222")).toBe("[REDACTED]");
		});
	});

	// ─── 国際電話番号 ───────────────────────────────────────────

	describe("国際電話番号のマスキング", () => {
		it("+81 で始まる番号がマスキングされる", () => {
			expect(maskSecrets("call +81901234567")).toBe("call [REDACTED]");
		});

		it("+1 で始まる番号がマスキングされる", () => {
			expect(maskSecrets("phone: +12025551234")).toBe("phone: [REDACTED]");
		});
	});

	// ─── API キー / トークン ────────────────────────────────────

	describe("API キー / トークンのマスキング", () => {
		it("sk- プレフィックスのキーがマスキングされる", () => {
			expect(maskSecrets("key=sk-proj-abcdefghij1234567890abcdef")).toBe("key=[REDACTED]");
		});

		it("ghp_ プレフィックスのトークンがマスキングされる", () => {
			expect(maskSecrets("token: ghp_ABCDEFghijklmnopqrstuvwxyz1234567890")).toBe(
				"token: [REDACTED]",
			);
		});

		it("xoxb- プレフィックスの Slack Bot トークンがマスキングされる", () => {
			expect(maskSecrets("SLACK_TOKEN=xoxb-1234-5678-abcdef")).toBe("SLACK_TOKEN=[REDACTED]");
		});

		it("xoxp- プレフィックスの Slack User トークンがマスキングされる", () => {
			expect(maskSecrets("token=xoxp-1234-5678-abcdef")).toBe("token=[REDACTED]");
		});

		it("gho_ プレフィックスの GitHub OAuth トークンがマスキングされる", () => {
			expect(maskSecrets("auth gho_abcdefghijklmnop")).toBe("auth [REDACTED]");
		});

		it("glpat- プレフィックスの GitLab トークンがマスキングされる", () => {
			expect(maskSecrets("GL_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx")).toBe("GL_TOKEN=[REDACTED]");
		});

		it("AKIA プレフィックスの AWS アクセスキーがマスキングされる", () => {
			expect(maskSecrets("aws_key=AKIAIOSFODNN7EXAMPLE")).toBe("aws_key=[REDACTED]");
		});
	});

	// ─── 複合パターン ───────────────────────────────────────────

	describe("複数パターンが混在するテキスト", () => {
		it("メールと電話番号が同時にマスキングされる", () => {
			const input = "Email: user@example.com, Tel: 090-1234-5678";
			const result = maskSecrets(input);

			expect(result).not.toContain("user@example.com");
			expect(result).not.toContain("090-1234-5678");
			expect(result).toContain("[REDACTED]");
		});

		it("API キーとメールが同時にマスキングされる", () => {
			const input = "key=sk-abc123def456 owner=admin@corp.com";
			const result = maskSecrets(input);

			expect(result).not.toContain("sk-abc123def456");
			expect(result).not.toContain("admin@corp.com");
		});
	});

	// ─── 非マスキング対象 ───────────────────────────────────────

	describe("PII/シークレットを含まないテキスト", () => {
		it("通常テキストは変更されない", () => {
			const input = "Hello, this is a normal log message.";
			expect(maskSecrets(input)).toBe(input);
		});

		it("数値のみの文字列は変更されない", () => {
			const input = "count=42";
			expect(maskSecrets(input)).toBe(input);
		});

		it("空文字列は変更されない", () => {
			expect(maskSecrets("")).toBe("");
		});
	});
});

// ─── redactObject ───────────────────────────────────────────────────

describe("redactObject", () => {
	// ─── immutability ───────────────────────────────────────────

	it("元オブジェクトを変更しない", () => {
		const original = { email: "user@example.com", count: 1 };
		const originalCopy = structuredClone(original);

		redactObject(original);

		expect(original).toEqual(originalCopy);
	});

	// ─── ネスト ─────────────────────────────────────────────────

	it("ネストしたオブジェクト内の文字列もマスキングする", () => {
		const input = {
			user: {
				contact: {
					email: "deep@nested.com",
				},
			},
		};
		const result = redactObject(input) as typeof input;

		expect(result.user.contact.email).toBe("[REDACTED]");
	});

	// ─── 配列 ───────────────────────────────────────────────────

	it("配列内の文字列もマスキングする", () => {
		const input = {
			tokens: ["ghp_secrettoken123", "normal-text"],
		};
		const result = redactObject(input) as typeof input;

		expect(result.tokens[0]).toBe("[REDACTED]");
		expect(result.tokens[1]).toBe("normal-text");
	});

	// ─── 非文字列値の保持 ───────────────────────────────────────

	describe("非文字列値をそのまま保持する", () => {
		it("number はそのまま保持される", () => {
			const result = redactObject({ port: 8080 }) as { port: number };
			expect(result.port).toBe(8080);
		});

		it("boolean はそのまま保持される", () => {
			const result = redactObject({ active: true }) as { active: boolean };
			expect(result.active).toBe(true);
		});

		it("null はそのまま保持される", () => {
			const result = redactObject({ data: null }) as { data: null };
			expect(result.data).toBeNull();
		});
	});

	// ─── プリミティブ入力 ───────────────────────────────────────

	it("文字列を直接渡した場合もマスキングされる", () => {
		expect(redactObject("user@example.com")).toBe("[REDACTED]");
	});

	it("数値を直接渡した場合はそのまま返る", () => {
		expect(redactObject(42)).toBe(42);
	});
});
