// Emergency gesture detector (pure — unit tested): TWO LONG BLINKS (eyes closed 1–3 s each) within 5 s.
// Works from any screen. Chosen over "eyes closed for N seconds" because a tired user resting their
// eyes would trigger that by accident; closures longer than maxMs (resting / dozing) don't count.
// Signal: MediaPipe eyeBlinkLeft/Right blendshapes, averaged [6].
// AI-assisted: written with help from Claude (Anthropic).

export interface LongBlinkOptions {
  closeAt: number; // blink score above this = eyes closed
  openAt: number; // below this = eyes open (hysteresis gap avoids flicker)
  minMs: number; // a closure must last at least this long to count as "long"
  maxMs: number; // ...and at most this long (longer = resting, ignored)
  windowMs: number; // both long blinks must finish within this window
  count: number; // long blinks needed
}

export const DEFAULT_LONG_BLINK: LongBlinkOptions = {
  closeAt: 0.55,
  openAt: 0.35,
  minMs: 1000,
  maxMs: 3000,
  windowMs: 5000,
  count: 2,
};

export interface LongBlinkState {
  closed: boolean;
  closedSince: number;
  longs: number[]; // end times of recent long blinks
}

export const initialLongBlink = (): LongBlinkState => ({ closed: false, closedSince: 0, longs: [] });

export type LongBlinkEvent = "none" | "long" | "trigger";

export function stepLongBlink(
  s: LongBlinkState,
  blink: number,
  now: number,
  o: LongBlinkOptions = DEFAULT_LONG_BLINK,
): { state: LongBlinkState; event: LongBlinkEvent; closedMs: number } {
  const longs = s.longs.filter((t) => now - t <= o.windowMs);
  if (!s.closed) {
    if (blink >= o.closeAt) return { state: { closed: true, closedSince: now, longs }, event: "none", closedMs: 0 };
    return { state: { ...s, longs }, event: "none", closedMs: 0 };
  }
  const closedMs = now - s.closedSince;
  if (blink > o.openAt) return { state: { ...s, longs }, event: "none", closedMs }; // still closed
  // eyes just opened: was that a long blink?
  if (closedMs >= o.minMs && closedMs <= o.maxMs) {
    const all = [...longs, now];
    if (all.length >= o.count) return { state: initialLongBlink(), event: "trigger", closedMs };
    return { state: { closed: false, closedSince: 0, longs: all }, event: "long", closedMs };
  }
  return { state: { closed: false, closedSince: 0, longs }, event: "none", closedMs };
}
