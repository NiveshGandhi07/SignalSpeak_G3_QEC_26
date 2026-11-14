// "Undo before speaking": a selected phrase waits a few seconds before it is spoken, so a mistaken
// selection can be cancelled. Pure helpers (unit tested); the bar itself is drawn by board.ts.
// AI-assisted: written with help from Claude (Anthropic).

export interface PendingSpeech {
  text: string;
  startedAt: number;
  delayMs: number;
  /** send to the caregiver's phone once actually spoken (never if cancelled) */
  notify?: "plain" | "ack";
}

export function remainingMs(p: PendingSpeech, now: number): number {
  return Math.max(0, p.delayMs - (now - p.startedAt));
}

export function isDue(p: PendingSpeech, now: number): boolean {
  return remainingMs(p, now) === 0;
}

/**
 * "Look away to cancel": is the (unclamped) gaze estimate clearly off the screen?
 * The margin keeps edge tiles from counting as looking away.
 */
export function isLookingAway(x: number, y: number, width: number, height: number, marginFrac = 0.08): boolean {
  const m = marginFrac * Math.min(width, height);
  return x < -m || x > width + m || y < -m || y > height + m;
}

/** 1 → 0 as the countdown runs out (for the shrinking bar). */
export function fractionLeft(p: PendingSpeech, now: number): number {
  return p.delayMs > 0 ? remainingMs(p, now) / p.delayMs : 0;
}
