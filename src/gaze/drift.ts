// Gaze drift correction (pure — unit tested).
// After calibration the cursor slowly drifts as the user slumps, shifts in the chair or the laptop
// moves. That kind of drift is mostly a constant shift of every gaze estimate, so it can be fixed with
// a screen-space offset instead of a full recalibration:
//  1. Implicit: whenever the user selects a tile they were (almost certainly) looking at it, so
//     "tile centre − cursor" is a free measurement of the drift. The median of a few of these nudges
//     the offset. Wildly off misses are ignored (the user may have looked at the tile edge).
//  2. Quick touch-up: 3 dots, ~6 s. If all three agree on one shift, apply it. If they disagree, the
//     error is not a simple shift (new seating position, lighting…) and a full calibration is needed.
// AI-assisted: written with help from Claude (Anthropic).
import { median } from "./calibration";

export type Vec = [number, number];

export interface DriftOptions {
  /** misses bigger than this (px) are ignored — probably not looking at the tile centre */
  maxResidual: number;
  /** selections collected before the offset is updated */
  window: number;
  /** median misses smaller than this (px) are noise — leave the offset alone */
  deadband: number;
  /** fraction of the measured drift corrected per update (cautious, converges over a few updates) */
  gain: number;
  /** the offset never grows beyond this (px); reaching it means "please recalibrate" */
  maxOffset: number;
}

export const DEFAULT_DRIFT: DriftOptions = { maxResidual: 260, window: 4, deadband: 25, gain: 0.6, maxOffset: 220 };

export interface DriftState {
  offset: Vec;
  residuals: Vec[];
  /** drift is at the limit of what an offset should fix — suggest a touch-up */
  needsRecal: boolean;
}

export const initialDrift = (offset: Vec = [0, 0]): DriftState => ({ offset, residuals: [], needsRecal: false });

export const applyOffset = (d: DriftState, x: number, y: number): Vec => [x + d.offset[0], y + d.offset[1]];

/** A selection happened: `target` is the tile centre, `cursor` the corrected cursor position. */
export function recordSelection(s: DriftState, target: Vec, cursor: Vec, o: DriftOptions = DEFAULT_DRIFT): DriftState {
  const r: Vec = [target[0] - cursor[0], target[1] - cursor[1]];
  if (Math.hypot(r[0], r[1]) > o.maxResidual) return s;
  const residuals = [...s.residuals, r];
  if (residuals.length < o.window) return { ...s, residuals };

  const m: Vec = [median(residuals.map((v) => v[0])), median(residuals.map((v) => v[1]))];
  if (Math.hypot(m[0], m[1]) < o.deadband) return { ...s, residuals: residuals.slice(1) }; // sliding window
  let offset: Vec = [s.offset[0] + o.gain * m[0], s.offset[1] + o.gain * m[1]];
  const len = Math.hypot(offset[0], offset[1]);
  const capped = len > o.maxOffset;
  if (capped) offset = [(offset[0] * o.maxOffset) / len, (offset[1] * o.maxOffset) / len];
  return { offset, residuals: [], needsRecal: capped };
}

export interface TouchUpOptions {
  /** each dot's shift may differ from the common shift by at most this (px) */
  maxDisagreement: number;
  /** a common shift bigger than this is too much for an offset (px) */
  maxShift: number;
}

export const DEFAULT_TOUCH_UP: TouchUpOptions = { maxDisagreement: 90, maxShift: 300 };

/**
 * Quick touch-up from a few dots. `points` = for each dot, its target and the model's predictions
 * (without any offset) while the user looked at it. Returns the new offset, or null when the dots
 * disagree / the shift is too big — then a full calibration is needed.
 */
export function touchUpOffset(points: { target: Vec; preds: Vec[] }[], o: TouchUpOptions = DEFAULT_TOUCH_UP): Vec | null {
  const shifts = points
    .filter((p) => p.preds.length >= 5)
    .map((p): Vec => [p.target[0] - median(p.preds.map((v) => v[0])), p.target[1] - median(p.preds.map((v) => v[1]))]);
  if (shifts.length < 2) return null;
  const common: Vec = [median(shifts.map((v) => v[0])), median(shifts.map((v) => v[1]))];
  if (Math.hypot(common[0], common[1]) > o.maxShift) return null;
  const agree = shifts.every((v) => Math.hypot(v[0] - common[0], v[1] - common[1]) <= o.maxDisagreement);
  return agree ? common : null;
}
