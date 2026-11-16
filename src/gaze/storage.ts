// Saved calibration: type + validation (pure — unit tested).
// Data read back from storage is untrusted input: it may be from an older version, truncated or
// tampered with. A malformed model would put NaN into the cursor position (a frozen or invisible
// cursor the user cannot recover from hands-free), so anything suspicious is rejected and the app
// simply calibrates again.
// AI-assisted: written with help from Claude (Anthropic).
import type { BrowParams } from "../events/brow";
import type { Calibration } from "./calibration";

/** Gaze model + this user's brow thresholds (null = brow raise not usable -> dwell mode) + drift offset. */
export type SavedCalibration = Calibration & { brow: BrowParams | null; offset?: [number, number] };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nums = (v: unknown, length?: number): v is number[] => Array.isArray(v) && v.every(num) && (length === undefined || v.length === length);
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Returns a clean copy (only known fields), or null if anything is missing or not a finite number. */
export function parseSavedCalibration(raw: unknown): SavedCalibration | null {
  if (!rec(raw) || !rec(raw.eye) || !rec(raw.reg)) return null;
  const { eye, reg, brow, offset, errorPx } = raw;
  if (!num(eye.cx) || !num(eye.cy) || !num(eye.kx) || !num(eye.ky) || !num(errorPx)) return null;
  if (!nums(reg.mean) || reg.mean.length === 0 || reg.mean.length > 32) return null;
  const d = reg.mean.length;
  if (!nums(reg.std, d) || !nums(reg.wx, d + 1) || !nums(reg.wy, d + 1)) return null;

  let cleanBrow: BrowParams | null = null;
  if (brow !== null && brow !== undefined) {
    if (!rec(brow) || !num(brow.baseline) || !num(brow.high) || !num(brow.low)) return null;
    if (!(brow.baseline < brow.low && brow.low < brow.high)) return null; // thresholds must be ordered
    cleanBrow = { baseline: brow.baseline, high: brow.high, low: brow.low };
  }
  return {
    eye: { cx: eye.cx, cy: eye.cy, kx: eye.kx, ky: eye.ky },
    reg: { mean: [...reg.mean], std: [...reg.std], wx: [...reg.wx], wy: [...reg.wy] },
    errorPx,
    brow: cleanBrow,
    offset: nums(offset, 2) && Math.hypot(offset[0], offset[1]) <= 400 ? [offset[0], offset[1]] : [0, 0],
  };
}
