// Tests for gaze drift correction and the quick touch-up. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { applyOffset, initialDrift, recordSelection, touchUpOffset, type DriftState, type Vec } from "../src/gaze/drift";

/** Simulate selections of tiles while the true gaze is shifted by `drift`; the cursor = gaze + offset. */
function selectMany(s: DriftState, drift: Vec, n: number, noise = 0): DriftState {
  for (let i = 0; i < n; i++) {
    const target: Vec = [300 + 200 * (i % 4), 300 + 150 * (i % 3)];
    const jitter = noise * Math.sin(i * 1.7);
    const raw: Vec = [target[0] - drift[0] + jitter, target[1] - drift[1] - jitter];
    s = recordSelection(s, target, applyOffset(s, ...raw));
  }
  return s;
}

describe("implicit drift correction", () => {
  it("learns a constant drift from ordinary selections", () => {
    const s = selectMany(initialDrift(), [80, -50], 40, 15);
    // corrects until the remaining miss is inside the 25 px deadband (from ~94 px to under 25)
    expect(Math.hypot(80 - s.offset[0], -50 - s.offset[1])).toBeLessThan(25);
    expect(s.needsRecal).toBe(false);
  });
  it("leaves a good calibration alone (small misses are noise)", () => {
    expect(selectMany(initialDrift(), [0, 0], 40, 15).offset).toEqual([0, 0]);
  });
  it("ignores wild misses (user looked elsewhere on a big tile)", () => {
    const s = recordSelection(initialDrift(), [500, 500], [100, 100]);
    expect(s.residuals).toHaveLength(0);
  });
  it("needs several selections before moving (one odd selection changes nothing)", () => {
    const s = recordSelection(initialDrift(), [500, 500], [400, 450]);
    expect(s.offset).toEqual([0, 0]);
  });
  it("caps the offset and flags a touch-up when drift is too large", () => {
    const s = selectMany(initialDrift(), [200, 150], 60); // 250 px: still measurable, beyond the 220 px cap
    expect(Math.hypot(...s.offset)).toBeLessThanOrEqual(220 + 1e-6);
    expect(s.needsRecal).toBe(true);
  });
  it("misses beyond the measurable range are left to the touch-up gesture", () => {
    expect(selectMany(initialDrift(), [240, 200], 20).offset).toEqual([0, 0]);
  });
});

describe("quick touch-up", () => {
  const targets: Vec[] = [[960, 540], [288, 216], [1632, 864]];
  const preds = (t: Vec, shift: Vec): Vec[] => Array.from({ length: 30 }, (_, i) => [t[0] - shift[0] + (i % 5) - 2, t[1] - shift[1] - (i % 3) + 1]);

  it("returns the common shift when all dots agree", () => {
    const off = touchUpOffset(targets.map((t) => ({ target: t, preds: preds(t, [60, -40]) })))!;
    expect(off[0]).toBeCloseTo(60, 0);
    expect(off[1]).toBeCloseTo(-40, 0);
  });
  it("returns null (=> full calibration) when the dots disagree", () => {
    const shifts: Vec[] = [[0, 0], [200, 0], [-150, 120]];
    expect(touchUpOffset(targets.map((t, i) => ({ target: t, preds: preds(t, shifts[i]) })))).toBeNull();
  });
  it("returns null when the shift is too big for an offset", () => {
    expect(touchUpOffset(targets.map((t) => ({ target: t, preds: preds(t, [400, 0]) })))).toBeNull();
  });
  it("returns null without enough data (face lost during the touch-up)", () => {
    expect(touchUpOffset(targets.map((t) => ({ target: t, preds: [] })))).toBeNull();
  });
});
