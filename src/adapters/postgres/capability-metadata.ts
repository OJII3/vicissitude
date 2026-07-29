export function validateMetadata(actor: string, reason: string, now: Date): void {
  if (!actor.trim() || !reason.trim()) throw new Error("actor and reason must be nonblank");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");
}
