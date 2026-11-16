// Tests for the pain-check grimace detector. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { grimaceScore, initialGrimace, stepGrimace, type GrimaceState } from "../src/events/grimace";

const FRAME = 33;

/** Feed segments of [score, blink, durationMs]; returns the number of prompts and the final state. */
function run(segs: [number, number, number][], start: GrimaceState = initialGrimace(), t0 = 0) {
  let s = start, t = t0, prompts = 0;
  for (const [score, blink, ms] of segs) {
    for (const end = t + ms; t < end; t += FRAME) {
      // tiny deterministic jitter so the learned variation isn't zero
      const r = stepGrimace(s, score + 0.01 * Math.sin(t / 97), blink, t);
      s = r.state;
      if (r.prompt) prompts++;
    }
  }
  return { prompts, state: s, t };
}

const settle: [number, number, number] = [0.1, 0.05, 5000]; // learn a neutral resting face

describe("grimaceScore", () => {
  it("averages brow-down, squint, sneer and frown", () => {
    const names = ["browDown", "eyeSquint", "noseSneer", "mouthFrown"].flatMap((n) => [`${n}Left`, `${n}Right`]);
    expect(grimaceScore(names.map((categoryName) => ({ categoryName, score: 0.8 })))).toBeCloseTo(0.8);
    expect(grimaceScore([])).toBe(0);
  });
});

describe("pain check (grimace detector)", () => {
  it("a neutral face never prompts", () => {
    expect(run([settle, [0.1, 0.05, 60_000]]).prompts).toBe(0);
  });
  it("a grimace held for 3 s prompts exactly once", () => {
    expect(run([settle, [0.5, 0.05, 3000], [0.1, 0.05, 2000]]).prompts).toBe(1);
  });
  it("a brief grimace (1 s) does not prompt", () => {
    expect(run([settle, [0.5, 0.05, 1000], [0.1, 0.05, 2000]]).prompts).toBe(0);
  });
  it("is personalised: a face that looks tense at rest does not prompt", () => {
    expect(run([[0.4, 0.05, 5000], [0.42, 0.05, 30_000]]).prompts).toBe(0);
    expect(run([[0.4, 0.05, 5000], [0.75, 0.05, 3000]]).prompts).toBe(1); // but a clear change does
  });
  it("does not ask again during the cooldown, but does after it", () => {
    const first = run([settle, [0.5, 0.05, 3000], [0.1, 0.05, 1000]]);
    const again = run([[0.5, 0.05, 3000]], first.state, first.t);
    expect(again.prompts).toBe(0);
    const later = run([[0.5, 0.05, 3000]], again.state, again.t + 3 * 60_000);
    expect(later.prompts).toBe(1);
  });
  it("closed eyes (long blinks, emergency gesture) are ignored", () => {
    expect(run([settle, [0.6, 0.9, 5000]]).prompts).toBe(0);
  });
  it("does not prompt before it has learned the resting face", () => {
    expect(run([[0.6, 0.05, 2000]]).prompts).toBe(0);
  });
});
