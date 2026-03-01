/**
 * チャンネルごとの応答クールダウンを管理する。
 * 純粋な in-memory 実装（永続化不要）。
 */
export class CooldownTracker {
	private lastResponseTime = new Map<string, number>();

	/**
	 * 指定チャンネルがクールダウン中かどうかを返す。
	 * @param channelId チャンネルID
	 * @param cooldownSeconds クールダウン秒数
	 * @param now 現在時刻（テスト用にDI可能）
	 */
	isOnCooldown(channelId: string, cooldownSeconds: number, now: number = Date.now()): boolean {
		const lastTime = this.lastResponseTime.get(channelId);
		if (lastTime === undefined) return false;
		return now - lastTime < cooldownSeconds * 1000;
	}

	/**
	 * 応答したことを記録する。
	 * @param channelId チャンネルID
	 * @param now 現在時刻（テスト用にDI可能）
	 */
	record(channelId: string, now: number = Date.now()): void {
		this.lastResponseTime.set(channelId, now);
	}
}
