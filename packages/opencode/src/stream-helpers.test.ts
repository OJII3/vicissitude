/**
 * classifyEvent の workspace イベント分岐に対するユニットテスト
 *
 * ホワイトボックステスト: 実装の内部分岐・フォールバック値・戻り値の厳密検証
 */
import { describe, expect, test } from "bun:test";

import type { Event } from "@opencode-ai/sdk/v2";
import { classifyEvent } from "@vicissitude/opencode/stream-helpers";
import type { TokenUsage } from "@vicissitude/shared/types";

const SESSION_ID = "unit-test-session";

describe("classifyEvent — workspace イベント", () => {
	// 1. workspace.failed の戻り値全フィールド厳密一致
	test("workspace.failed の戻り値が全フィールド厳密に一致する", () => {
		const event = {
			type: "workspace.failed",
			properties: { message: "init timeout" },
		} as unknown as Event;

		const result = classifyEvent(event, SESSION_ID, new Map());

		expect(result).toEqual({
			type: "error",
			message: "init timeout",
			retryable: true,
			errorClass: "WorkspaceFailed",
		});
	});

	// 3. workspace.status status="error" → 固定メッセージ
	test("workspace.status (status='error') は 'workspace error' を返す", () => {
		const event = {
			type: "workspace.status",
			properties: { status: "error" },
		} as unknown as Event;

		const result = classifyEvent(event, SESSION_ID, new Map());

		expect(result).toEqual({
			type: "error",
			message: "workspace error",
			retryable: true,
			errorClass: "WorkspaceError",
		});
	});

	// 4. workspace.status status="disconnected" 戻り値厳密一致
	test("workspace.status (status='disconnected') の戻り値が厳密に一致する", () => {
		const event = {
			type: "workspace.status",
			properties: { status: "disconnected" },
		} as unknown as Event;

		const result = classifyEvent(event, SESSION_ID, new Map());

		expect(result).toEqual({
			type: "error",
			message: "workspace disconnected",
			retryable: true,
			errorClass: "WorkspaceDisconnected",
		});
	});

	// 5. workspace.status status="connected" → null
	test("workspace.status (status='connected') は null を返す", () => {
		const event = {
			type: "workspace.status",
			properties: { status: "connected" },
		} as unknown as Event;

		const result = classifyEvent(event, SESSION_ID, new Map());

		expect(result).toBeNull();
	});

	// 6. workspace.status status="connecting" → null
	test("workspace.status (status='connecting') は null を返す", () => {
		const event = {
			type: "workspace.status",
			properties: { status: "connecting" },
		} as unknown as Event;

		const result = classifyEvent(event, SESSION_ID, new Map());

		expect(result).toBeNull();
	});

	// 7. workspace.ready → null
	test("workspace.ready は null を返す", () => {
		const event = {
			type: "workspace.ready",
			properties: { name: "ws-1" },
		} as unknown as Event;

		const result = classifyEvent(event, SESSION_ID, new Map());

		expect(result).toBeNull();
	});

	// 9. workspace イベントが tokensByMessage に影響を与えない
	test("workspace イベントが tokensByMessage を変更しない", () => {
		const tokensByMessage = new Map<string, TokenUsage>([
			["msg-1", { input: 100, output: 50, cacheRead: 10 }],
		]);
		const snapshotBefore = new Map(tokensByMessage);

		const events = [
			{ type: "workspace.failed", properties: { message: "fail" } },
			{ type: "workspace.status", properties: { status: "error" } },
			{ type: "workspace.status", properties: { status: "disconnected" } },
			{ type: "workspace.status", properties: { status: "connected" } },
			{ type: "workspace.ready", properties: {} },
		];

		for (const raw of events) {
			classifyEvent(raw as unknown as Event, SESSION_ID, tokensByMessage);
		}

		expect(tokensByMessage).toEqual(snapshotBefore);
	});
});
