// Tests for long-blink emergency gesture, fatigue-aware pacing and undo-before-speaking.
// Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { initialLongBlink, stepLongBlink, type LongBlinkEvent } from "../src/events/longBlink";
import { FatigueTracker } from "../src/adapt/fatigue";
import { fractionLeft, isDue, isLookingAway, remainingMs } from "../src/ui/pendingSpeech";
import { scaleBrow } from "../src/events/brow";

/** Simulate eyes: segments of [blinkScore, durationMs] sampled every 33 ms. Returns emitted events. */
function eyes(segments: [number, number][]): LongBlinkEvent[] {
  let s = initialLongBlink();
  let t = 0;
  const events: LongBlinkEvent[] = [];
  for (const [v, ms] of segments) {
    for (const end = t + ms; t < end; t += 33) {
      const r = stepLongBlink(s, v, t);
      s = r.state;
      if (r.event !== "none") events.push(r.event);
    }
  }
  return events;
}
const OPEN = 0.05, SHUT = 0.9;

describe("emergency gesture: two long blinks", () => {
  it("two long blinks trigger the emergency", () => {
    expect(eyes([[OPEN, 500], [SHUT, 1300], [OPEN, 600], [SHUT, 1300], [OPEN, 200]])).toEqual(["long", "trigger"]);
  });
  it("normal blinks never trigger", () => {
    const blinks: [number, number][] = [];
    for (let i = 0; i < 30; i++) blinks.push([OPEN, 2000], [SHUT, 200]);
    expect(eyes(blinks)).toEqual([]);
  });
  it("resting eyes (long closures) don't count", () => {
    expect(eyes([[SHUT, 6000], [OPEN, 500], [SHUT, 6000], [OPEN, 500]])).toEqual([]);
  });
  it("two long blinks too far apart don't trigger", () => {
    expect(eyes([[SHUT, 1300], [OPEN, 6000], [SHUT, 1300], [OPEN, 200]])).toEqual(["long", "long"]);
  });
  it("half-closed eyes (in the hysteresis gap) don't flicker the state", () => {
    expect(eyes([[0.45, 3000]])).toEqual([]);
  });
});

describe("fatigue tracker", () => {
  const fresh = () => {
    const f = new FatigueTracker();
    for (let i = 0; i < 5; i++) f.recordSelection(800, i * 5000); // baseline ~800 ms
    return f;
  };

  it("starts fresh with the base timings", () => {
    const p = fresh().pacing();
    expect(p.level).toBe("fresh");
    expect(p.dwellMs).toBe(1500);
    expect(p.preferDwell).toBe(false);
  });

  it("slower selections raise fatigue and slow the pace", () => {
    const f = fresh();
    for (let i = 0; i < 12; i++) f.recordSelection(1800, 30_000 + i * 5000);
    const p = f.pacing();
    expect(p.score).toBeGreaterThan(0.33);
    expect(p.dwellMs).toBeGreaterThan(1500);
    expect(p.speakDelayMs).toBeGreaterThan(2500);
    expect(p.browThresholdScale).toBeLessThan(1);
  });

  it("weakening eyebrow raises switch to look-and-hold, and back when they recover", () => {
    const f = fresh();
    for (let i = 0; i < 15; i++) f.recordBrowAmplitude(0.3, 30_000 + i * 3000);
    expect(f.pacing().preferDwell).toBe(true);
    for (let i = 0; i < 15; i++) f.recordBrowAmplitude(1.0, 80_000 + i * 3000);
    expect(f.pacing().preferDwell).toBe(false);
  });

  it("frequent undos count as fatigue", () => {
    const f = fresh();
    for (let i = 0; i < 6; i++) {
      f.recordSelection(800, 30_000 + i * 4000);
      f.recordUndo(31_000 + i * 4000);
    }
    expect(f.components().undo).toBe(1);
    expect(f.score()).toBeGreaterThan(0.2);
  });

  it("a long break lets the score recover", () => {
    const f = fresh();
    for (let i = 0; i < 12; i++) f.recordSelection(2000, 30_000 + i * 5000);
    const tired = f.score();
    f.recordSelection(800, 30_000 + 12 * 5000 + 5 * 60_000); // after a 5 min rest
    expect(f.score()).toBeLessThan(tired);
  });
});

describe("undo before speaking", () => {
  const p = { text: "Water", startedAt: 1000, delayMs: 2500 };
  it("counts down and becomes due", () => {
    expect(remainingMs(p, 1000)).toBe(2500);
    expect(isDue(p, 3000)).toBe(false);
    expect(isDue(p, 3500)).toBe(true);
    expect(fractionLeft(p, 2250)).toBeCloseTo(0.5);
  });
  it("look away = gaze clearly off-screen; edge tiles don't count", () => {
    const W = 1600, H = 900; // margin = 0.08 * 900 = 72 px
    expect(isLookingAway(800, 450, W, H)).toBe(false);
    expect(isLookingAway(-30, 450, W, H)).toBe(false); // just past the edge: still "on" an edge tile
    expect(isLookingAway(-100, 450, W, H)).toBe(true);
    expect(isLookingAway(800, H + 100, W, H)).toBe(true);
  });
  it("Yes/No get a shorter undo window than other phrases", () => {
    const pace = new FatigueTracker().pacing();
    expect(pace.quickSpeakDelayMs).toBe(1500);
    expect(pace.quickSpeakDelayMs).toBeLessThan(pace.speakDelayMs);
  });
});

describe("scaleBrow", () => {
  it("lowers thresholds toward the baseline when tired", () => {
    const s = scaleBrow({ baseline: 0.1, high: 0.3, low: 0.2 }, 0.7);
    expect(s.high).toBeCloseTo(0.24);
    expect(s.low).toBeCloseTo(0.17);
    expect(s.baseline).toBe(0.1);
  });
});
