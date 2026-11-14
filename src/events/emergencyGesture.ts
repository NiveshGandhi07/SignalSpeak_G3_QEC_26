// Emergency gesture "binds": the user (or caregiver) picks which gesture raises the alarm from any
// screen. All detectors are pure state machines; this file wraps them behind one small interface.
//   twoLongBlinks    — eyes closed 1–3 s, open, again within 5 s            (default)
//   twoLongCloses    — eyes closed ≥3 s, open, again within 5 s
//   closedBrowRaises — eyes closed, then raise the eyebrows 3 times (needs a calibrated brow raise)
// AI-assisted: written with help from Claude (Anthropic).
import type { BrowParams } from "./brow";
import { DEFAULT_LONG_BLINK, initialLongBlink, stepLongBlink, type LongBlinkOptions, type LongBlinkState } from "./longBlink";

export type EmergencyBind = "twoLongBlinks" | "twoLongCloses" | "closedBrowRaises";

export interface BindOption {
  id: EmergencyBind;
  label: string;
  sub: string;
  needsBrow: boolean;
}

export const EMERGENCY_BINDS: BindOption[] = [
  { id: "twoLongBlinks", label: "Two long blinks", sub: "Close eyes 1–3 s, open, repeat within 5 s", needsBrow: false },
  { id: "closedBrowRaises", label: "Eyes closed + 3 brow raises", sub: "Close eyes, raise eyebrows three times", needsBrow: true },
  { id: "twoLongCloses", label: "Two 3-second closes", sub: "Close eyes 3 s, open, repeat within 5 s", needsBrow: false },
];

export interface Binds {
  emergency: EmergencyBind;
}

export const DEFAULT_BINDS: Binds = { emergency: "twoLongBlinks" };

export function parseBinds(raw: unknown): Binds {
  const e = (raw as Partial<Binds> | null)?.emergency;
  return { emergency: EMERGENCY_BINDS.some((b) => b.id === e) ? (e as EmergencyBind) : DEFAULT_BINDS.emergency };
}

export const TWO_LONG_CLOSES: LongBlinkOptions = { ...DEFAULT_LONG_BLINK, minMs: 3000, maxMs: 8000, gapMs: 5000, count: 2 };

// ---------- eyes closed + N brow raises ----------
export interface ClosedRaiseOptions {
  closeAt: number;
  openAt: number;
  raises: number;
  maxClosedMs: number; // closure longer than this = resting; the count starts over
}

export const DEFAULT_CLOSED_RAISE: ClosedRaiseOptions = { closeAt: 0.55, openAt: 0.35, raises: 3, maxClosedMs: 10_000 };

export interface ClosedRaiseState {
  closed: boolean;
  closedSince: number;
  browUp: boolean;
  raises: number;
}

export const initialClosedRaise = (): ClosedRaiseState => ({ closed: false, closedSince: 0, browUp: false, raises: 0 });

export type GestureEvent = "none" | "progress" | "trigger";

export function stepClosedRaises(
  s: ClosedRaiseState,
  blink: number,
  brow: number,
  now: number,
  p: BrowParams,
  o: ClosedRaiseOptions = DEFAULT_CLOSED_RAISE,
): { state: ClosedRaiseState; event: GestureEvent; count: number } {
  if (!s.closed) {
    if (blink >= o.closeAt) return { state: { closed: true, closedSince: now, browUp: brow >= p.high, raises: 0 }, event: "none", count: 0 };
    return { state: s, event: "none", count: 0 };
  }
  if (blink <= o.openAt) return { state: initialClosedRaise(), event: "none", count: 0 }; // opened early: start over
  if (now - s.closedSince > o.maxClosedMs) return { state: { ...s, closedSince: now, raises: 0, browUp: brow >= p.high }, event: "none", count: 0 };
  if (!s.browUp && brow >= p.high) {
    const raises = s.raises + 1;
    if (raises >= o.raises) return { state: initialClosedRaise(), event: "trigger", count: raises };
    return { state: { ...s, browUp: true, raises }, event: "progress", count: raises };
  }
  if (s.browUp && brow <= p.low) return { state: { ...s, browUp: false }, event: "none", count: s.raises };
  return { state: s, event: "none", count: s.raises };
}

// ---------- unified detector ----------
export interface EmergencyDetector {
  readonly bind: EmergencyBind;
  readonly needed: number;
  step(blink: number, brow: number, now: number): { event: GestureEvent; count: number };
  reset(): void;
}

/** Builds the detector for a bind. Falls back to two long blinks if the bind needs a brow raise the user doesn't have. */
export function createEmergencyDetector(bind: EmergencyBind, brow: BrowParams | null): EmergencyDetector {
  if (bind === "closedBrowRaises" && brow) {
    let s = initialClosedRaise();
    return {
      bind,
      needed: DEFAULT_CLOSED_RAISE.raises,
      step: (blink, b, now) => {
        const r = stepClosedRaises(s, blink, b, now, brow);
        s = r.state;
        return { event: r.event, count: r.count };
      },
      reset: () => (s = initialClosedRaise()),
    };
  }
  const effective: EmergencyBind = bind === "closedBrowRaises" ? "twoLongBlinks" : bind;
  const o = effective === "twoLongCloses" ? TWO_LONG_CLOSES : DEFAULT_LONG_BLINK;
  let s: LongBlinkState = initialLongBlink();
  return {
    bind: effective,
    needed: o.count,
    step: (blink, _b, now) => {
      const r = stepLongBlink(s, blink, now, o);
      s = r.state;
      return { event: r.event === "long" ? "progress" : r.event, count: r.event === "long" ? s.longs.length : r.event === "trigger" ? o.count : 0 };
    },
    reset: () => (s = initialLongBlink()),
  };
}
