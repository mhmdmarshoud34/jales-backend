/**
 * Verbose logs for verifying DB writes (sessions, readings, posture).
 * Set SAVE_DEBUG_LOGS=false in .env to disable.
 */
export function saveDebugEnabled(): boolean {
  return process.env.SAVE_DEBUG_LOGS !== "false";
}

export function saveDebug(tag: string, payload: Record<string, unknown>): void {
  if (!saveDebugEnabled()) return;
  try {
    console.log(`[save-debug] ${tag}`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[save-debug] ${tag}`, payload);
  }
}
