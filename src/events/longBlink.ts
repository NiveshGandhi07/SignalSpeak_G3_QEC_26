// Long-blink sequence detector (pure — unit tested): N eye closures of minMs–maxMs each, with at most
// gapMs between one closure ending and the next beginning. Used for the emergency gesture presets
// "two long blinks" (1–3 s each) and "two 3-second closes". Closures longer than maxMs (resting /
// dozing) never count, so a tired user resting their eyes can't trigger it by accident.
// Signal: MediaPipe eyeBlinkLeft/Right blendshapes, averaged [6].
// AI-assisted: written with help from Claude (Anthropic).

export interface LongBlinkOptions {
  closeAt: number; // blink score above this = eyes closed
  openAt: number; // below this = eyes open (hysteresis gap avoids flicker)
  minMs: number; // a closure must last at least this long to count
  maxMs: number; // ...and at most this long (longer = resting, ignored)
  gapMs: number; // max time from one closure ending to the next starting
  count: number; // closures needed
}

export const DEFAULT_LONG_BLINK: LongBlinkOptions = {
  closeAt: 0.55,
  openAt: 0.35,
  minMs: 1000,
  maxMs: 3000,
  gapMs: 5000,
  count: 2,
};

export interface LongBlinkState {
  closed: boolean;
  closedSince: number;
  longs: number[]; // end times of recent qualifying closures
}

export const initialLongBlink = (): LongBlinkState => ({ closed: false, closedSince: 0, longs: [] });

export type LongBlinkEvent = "none" | "long" | "trigger";

export function stepLongBlink(
  s: LongBlinkState,
  blink: number,
  now: number,
  o: LongBlinkOptions = DEFAULT_LONG_BLINK,
): { state: LongBlinkState; event: LongBlinkEvent; closedMs: number } {
  if (!s.closed) {
    if (blink >= o.closeAt) {
      // a new closure starts: forget earlier closures that ended too long ago
      const longs = s.longs.filter((t) => now - t <= o.gapMs);
      return { state: { closed: true, closedSince: now, longs }, event: "none", closedMs: 0 };
    }
    return { state: s, event: "none", closedMs: 0 };
  }
  const closedMs = now - s.closedSince;
  if (blink > o.openAt) return { state: s, event: "none", closedMs }; // still closed
  // eyes just opened: did that closure qualify?
  if (closedMs >= o.minMs && closedMs <= o.maxMs) {
    const all = [...s.longs, now];
    if (all.length >= o.count) return { state: initialLongBlink(), event: "trigger", closedMs };
    return { state: { closed: false, closedSince: 0, longs: all }, event: "long", closedMs };
  }
  return { state: { closed: false, closedSince: 0, longs: s.longs }, event: "none", closedMs };
}
