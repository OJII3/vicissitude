import type { Attachment } from "@vicissitude/shared/types";

export interface PendingMessage {
	text: string;
	attachments?: Attachment[];
	trigger: string;
	scopeId?: string;
}

export interface DrainedMessages {
	text: string;
	attachments: Attachment[];
	trigger: string;
	scopeId?: string;
}

/** 複数値をメトリクスラベル用に集約する。空→fallback / 1種→その値 / 複数→"mixed" */
export function mergeMetricLabel(values: Array<string | undefined>, fallback: string): string {
	const unique = [...new Set(values.filter((value): value is string => !!value))];
	if (unique.length === 0) return fallback;
	if (unique.length === 1) return unique[0] ?? fallback;
	return "mixed";
}

/**
 * AgentRunner の受信メッセージバッファとリトライ用 lastPrompt 状態を保持する。
 * 待機(waitForMessages/waitForDebounce)のタイミング制御は AgentRunner 側のシームに残し、
 * 本クラスはデータ保持・drain・merge・requeue のみを担う（外部から観察されない）。
 */
export class MessageBuffer {
	private pending: PendingMessage[] = [];
	private botPending = false;
	private lastText: string | null = null;
	private lastAttachments: Attachment[] | null = null;
	private lastTrigger: string | null = null;
	private lastScopeId: string | null = null;

	enqueue(message: PendingMessage, isBot: boolean): void {
		this.pending.push(message);
		if (isBot) this.botPending = true;
	}

	get size(): number {
		return this.pending.length;
	}

	get hasBotPending(): boolean {
		return this.botPending;
	}

	get hasLastPrompt(): boolean {
		return this.lastText !== null;
	}

	/** 通常フロー: 蓄積メッセージをまとめて取り出し、bot フラグをリセットする */
	drain(fallbackScopeId: string | undefined): DrainedMessages {
		const items = this.pending.splice(0);
		this.botPending = false;
		return {
			text: items.map((m) => m.text).join("\n---\n"),
			attachments: items.flatMap((m) => m.attachments ?? []),
			trigger: mergeMetricLabel(
				items.map((m) => m.trigger),
				"unknown",
			),
			scopeId: mergeMetricLabel(
				items.map((m) => m.scopeId),
				fallbackScopeId ?? "none",
			),
		};
	}

	/** リトライフロー: lastPrompt を再利用し、新着があればマージする */
	drainForRetry(fallbackScopeId: string | undefined): DrainedMessages {
		const lastText = this.lastText ?? "";
		const drained = this.drain(fallbackScopeId);
		const hasDrained = drained.text.length > 0 || drained.attachments.length > 0;
		return {
			text: drained.text ? `${lastText}\n---\n${drained.text}` : lastText,
			attachments: [...(this.lastAttachments ?? []), ...drained.attachments],
			trigger: mergeMetricLabel(
				[this.lastTrigger ?? undefined, hasDrained ? drained.trigger : undefined],
				"unknown",
			),
			scopeId: mergeMetricLabel(
				[this.lastScopeId ?? undefined, hasDrained ? drained.scopeId : undefined],
				fallbackScopeId ?? "none",
			),
		};
	}

	setLastPrompt(
		text: string,
		attachments: Attachment[],
		trigger: string,
		scopeId: string | undefined,
	): void {
		this.lastText = text;
		this.lastAttachments = attachments;
		this.lastTrigger = trigger;
		this.lastScopeId = scopeId ?? null;
	}

	clearLastPrompt(): void {
		this.lastText = null;
		this.lastAttachments = null;
		this.lastTrigger = null;
		this.lastScopeId = null;
	}

	/** 中断時に直前プロンプトを先頭へ戻す（lastPrompt が無ければ何もしない） */
	requeueLastPrompt(): void {
		if (this.lastText === null) return;
		this.pending.unshift({
			text: this.lastText,
			attachments: this.lastAttachments ?? undefined,
			trigger: this.lastTrigger ?? "unknown",
			scopeId: this.lastScopeId ?? undefined,
		});
	}
}
