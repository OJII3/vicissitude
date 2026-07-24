import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("logger", () => {
  it("redacts nested secrets and emits ISO timestamps", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    logger.info(
      {
        DISCORD_TOKEN: "token",
        config: { DATABASE_URL: "postgres://secret" },
        request: { headers: { authorization: "Bearer secret" } },
        apiKey: "key",
      },
      "hello",
    );
    expect(lines.join(" ")).not.toContain("token");
    expect(lines.join(" ")).not.toContain("secret");
    expect(lines.join(" ")).not.toContain("key");
    expect(JSON.parse(lines[0]!).time).toMatch(/Z$/u);
  });
  it("redacts arbitrary-depth arrays without mutating or breaking dates/cycles", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    const input: { values: unknown[] } = { values: [] };
    input.values.push({
      config: { request: { headers: { Authorization: "secret-array" }, api_key: "secret-key" } },
      state: "ok",
      date: new Date("2020-01-01T00:00:00Z"),
    });
    input.values.push(input);
    logger.info(input, "nested");
    const serialized = lines.join(" ");
    expect(serialized).not.toContain("secret-array");
    expect(serialized).not.toContain("secret-key");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("2020-01-01");
    expect(input.values[0]).toMatchObject({ state: "ok" });
  });
  it("redacts child bindings through nested child chains without mutating them", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    const bindings = {
      config: { DATABASE_URL: "child-db-secret" },
      values: [{ Authorization: "child-auth-secret" }, { api_key: "child-key-secret" }],
      requestId: "request-123",
    };
    logger.child(bindings).info("direct child");
    const nested = logger.child(bindings).child({ DISCORD_TOKEN: "nested-token-secret", attempt: 2 });

    nested.info({ detail: { database_url: "log-db-secret" } }, "child message");

    const serialized = lines.join(" ");
    expect(serialized).not.toContain("child-db-secret");
    expect(serialized).not.toContain("child-auth-secret");
    expect(serialized).not.toContain("child-key-secret");
    expect(serialized).not.toContain("nested-token-secret");
    expect(serialized).not.toContain("log-db-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("request-123");
    expect(serialized).toContain('"attempt":2');
    expect(bindings).toEqual({
      config: { DATABASE_URL: "child-db-secret" },
      values: [{ Authorization: "child-auth-secret" }, { api_key: "child-key-secret" }],
      requestId: "request-123",
    });
  });
  it("redacts every log argument including strings, formats, errors, and control characters", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    const error = new Error("authorization: Bearer error-secret token=error-token");
    error.stack = `Error: ${error.message}\n    at /tmp/authorization: Bearer stack-secret`;
    const input = {
      message: "token=input-token",
      nested: { DATABASE_URL: "postgres://db-user:db-secret@host/db" },
      date: new Date("2020-01-01T00:00:00Z"),
    };

    logger.info("authorization: Bearer string-secret\napi_key: key-secret");
    logger.info("request %s token=%s", "authorization: Bearer format-secret", "token=format-token");
    logger.error(error, "DISCORD_TOKEN=error-discord");
    logger.info(input, "postgresql://user:password@host/db\u0000");

    const serialized = lines.join(" ");
    for (const secret of [
      "string-secret",
      "key-secret",
      "authorization: Bearer format-secret",
      "format-token",
      "error-secret",
      "error-token",
      "stack-secret",
      "error-discord",
      "input-token",
      "db-secret",
      "password",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("2020-01-01");
    expect(serialized).toContain("request");
    expect(
      Array.from(serialized.replaceAll("\n", ""), (character) => character.codePointAt(0) ?? 0).every(
        (code) => code >= 0x20 && code !== 0x7f,
      ),
    ).toBe(true);
    expect(input).toEqual({
      message: "token=input-token",
      nested: { DATABASE_URL: "postgres://db-user:db-secret@host/db" },
      date: new Date("2020-01-01T00:00:00Z"),
    });
    expect(serialized).toContain('"name":"Error"');
    expect(serialized).toContain('"message":"');
  });
  it("redacts every authorization scheme and complete postgres URLs", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    const values = [
      "Authorization: Basic basic-credential",
      "authorization=Digest digest-credential",
      "Authorization: Custom custom-credential; next=ok",
      "postgres://user@host?password=query-password&token=query-token",
      "postgresql://:colon-password@host/db",
      "postgres://@host/db?sslpassword=empty-user-password",
      "postgresql://host/db?password=query-only-password",
    ];
    logger.info(values.join(" | "));
    const error = new Error(`stack postgresql://${values[3]}`);
    logger.error(error);

    const serialized = lines.join(" ");
    for (const secret of [
      "basic-credential",
      "digest-credential",
      "custom-credential",
      "query-password",
      "query-token",
      "colon-password",
      "empty-user-password",
      "query-only-password",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized.match(/postgres(?:ql)?:\/\//giu)).toBeNull();
  });
  it("redacts authorization lines through Digest and AWS signatures without consuming the next event", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    logger.info(
      'Authorization: Digest username="digest-user", realm="digest-realm", response="digest-response"\n' +
        "eventId=event-456",
    );
    logger.info(
      "authorization=AWS4-HMAC-SHA256 Credential=aws-credential, SignedHeaders=aws-headers, Signature=aws-signature\n" +
        "eventId=event-789",
    );

    const serialized = lines.join(" ");
    for (const secret of [
      "digest-user",
      "digest-realm",
      "digest-response",
      "aws-credential",
      "aws-headers",
      "aws-signature",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("event-456");
    expect(serialized).toContain("event-789");
  });
});
