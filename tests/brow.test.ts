// Tests for the eyebrow-raise click detector. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { browScore, calibrateBrow, initialBrow, stepBrow, type BrowParams } from "../src/events/brow";

const P: BrowParams = { baseline: 0.1, high: 0.3, low: 0.2 };

/** Feed a brow signal sampled every 33 ms; return the times of clicks. */
function clicks(signal: number[], p = P): number[] {
  let s = initialBrow();
  const out: number[] = [];
  signal.forEach((v, i) => {
    const r = stepBrow(s, v, i * 33, p);
    s = r.state;
    if (r.click) out.push(i * 33);
  });
  return out;
}
const hold = (v: number, frames: number) => Array<number>(frames).fill(v);

describe("browScore", () => {
  it("averages inner and outer brow raise", () => {
    const shapes = [
      { categoryName: "browInnerUp", score: 0.6 },
      { categoryName: "browOuterUpLeft", score: 0.2 },
      { categoryName: "browOuterUpRight", score: 0.4 },
    ];
    expect(browScore(shapes)).toBeCloseTo(0.45);
  });
});

describe("calibrateBrow", () => {
  it("sets thresholds between the user's resting and raised levels", () => {
    const p = calibrateBrow(hold(0.1, 30), hold(0.5, 30))!;
    expect(p.baseline).toBeCloseTo(0.1);
    expect(p.high).toBeCloseTo(0.3);
    expect(p.low).toBeCloseTo(0.2);
  });
  it("returns null (-> dwell fallback) when the raise is too small", () => {
    expect(calibrateBrow(hold(0.1, 30), hold(0.15, 30))).toBeNull();
  });
  it("returns null without enough data", () => {
    expect(calibrateBrow([0.1], [0.5])).toBeNull();
  });
  it("tolerates the user only raising for part of the window", () => {
    const p = calibrateBrow(hold(0.1, 30), [...hold(0.1, 5), ...hold(0.5, 25)]);
    expect(p).not.toBeNull();
  });
});

describe("stepBrow", () => {
  it("one deliberate raise = exactly one click", () => {
    expect(clicks([...hold(0.1, 10), ...hold(0.5, 30), ...hold(0.1, 10)])).toHaveLength(1);
  });
  it("ignores a one-frame spike (tracking glitch)", () => {
    expect(clicks([...hold(0.1, 10), 0.6, ...hold(0.1, 10)])).toHaveLength(0);
  });
  it("ignores resting noise below the threshold", () => {
    expect(clicks(Array.from({ length: 200 }, (_, i) => 0.1 + 0.08 * Math.sin(i)))).toHaveLength(0);
  });
  it("needs brows to come back down (hysteresis) before clicking again", () => {
    // hovering between low and high must not re-trigger
    expect(clicks([...hold(0.5, 10), ...hold(0.25, 30), ...hold(0.5, 10)])).toHaveLength(1);
  });
  it("two separate raises = two clicks", () => {
    const raise = [...hold(0.5, 10), ...hold(0.1, 20)];
    expect(clicks([...raise, ...raise])).toHaveLength(2);
  });
  it("reports raise level 0..1 for the on-screen ring", () => {
    expect(stepBrow(initialBrow(), 0.1, 0, P).level).toBe(0);
    expect(stepBrow(initialBrow(), 0.2, 0, P).level).toBeCloseTo(0.5);
    expect(stepBrow(initialBrow(), 0.9, 0, P).level).toBe(1);
  });
});
