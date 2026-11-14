// Eyebrow-raise "click" detector (pure — unit tested).
// Signal: MediaPipe blendshapes browInnerUp + browOuterUp{Left,Right} [6].
// Personalised: thresholds come from this user's resting brow level and their own raised level,
// measured during calibration. Hysteresis (high/low thresholds) + a short hold + a refractory period
// stop noise and a single long raise from producing multiple clicks.
// AI-assisted: written with help from Claude (Anthropic).
import type { Blendshape } from "../gaze/features";
import { median } from "../gaze/calibration";

export interface BrowParams {
  baseline: number; // resting level
  high: number; // must rise above this to click
  low: number; // must fall below this to re-arm
}

export interface BrowOptions {
  minHoldMs: number; // raise must last this long (filters twitches / tracking spikes)
  refractoryMs: number; // minimum time between clicks
}

export const DEFAULT_BROW_OPTIONS: BrowOptions = { minHoldMs: 100, refractoryMs: 700 };

/** Minimum (raised − resting) difference for brows to be a usable control channel. */
export const MIN_BROW_RANGE = 0.08;

function score(shapes: Blendshape[], name: string): number {
  return shapes.find((s) => s.categoryName === name)?.score ?? 0;
}

export function browScore(shapes: Blendshape[]): number {
  const outer = (score(shapes, "browOuterUpLeft") + score(shapes, "browOuterUpRight")) / 2;
  return (score(shapes, "browInnerUp") + outer) / 2;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/**
 * Thresholds from resting samples and "raise your eyebrows" samples.
 * Returns null if the user can't raise their brows clearly enough — the app then falls back to dwell.
 */
export function calibrateBrow(rest: number[], raised: number[]): BrowParams | null {
  if (rest.length < 5 || raised.length < 5) return null;
  const baseline = median(rest);
  const peak = percentile(raised, 0.8); // robust to a few spikes; user may not hold the whole time
  const range = peak - baseline;
  if (range < MIN_BROW_RANGE) return null;
  return { baseline, high: baseline + 0.5 * range, low: baseline + 0.25 * range };
}

/** Scale thresholds toward the baseline (k < 1 = a smaller raise is enough; used when the user tires). */
export function scaleBrow(p: BrowParams, k: number): BrowParams {
  return { baseline: p.baseline, high: p.baseline + (p.high - p.baseline) * k, low: p.baseline + (p.low - p.baseline) * k };
}

export interface BrowState {
  up: boolean;
  aboveSince: number | null;
  lastClick: number;
}

export const initialBrow = (): BrowState => ({ up: false, aboveSince: null, lastClick: -Infinity });

export function stepBrow(
  s: BrowState,
  value: number,
  now: number,
  p: BrowParams,
  o: BrowOptions = DEFAULT_BROW_OPTIONS,
): { state: BrowState; click: boolean; level: number } {
  const level = Math.min(1, Math.max(0, (value - p.baseline) / (p.high - p.baseline || 1e-6)));
  if (s.up) {
    // wait for the brows to come back down before another click is possible
    const state = value <= p.low ? { ...s, up: false, aboveSince: null } : s;
    return { state, click: false, level };
  }
  if (value < p.high) return { state: { ...s, aboveSince: null }, click: false, level };
  const aboveSince = s.aboveSince ?? now;
  if (now - aboveSince >= o.minHoldMs && now - s.lastClick >= o.refractoryMs) {
    return { state: { up: true, aboveSince, lastClick: now }, click: true, level };
  }
  return { state: { ...s, aboveSince }, click: false, level };
}
