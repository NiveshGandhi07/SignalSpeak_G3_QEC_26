// Unit tests for the gaze pipeline. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { headPose, irisInEye, LEFT_EYE, RIGHT_EYE, type Pt, type RawGaze } from "../src/gaze/features";
import { fitGazeModel, predict, solve } from "../src/gaze/regression";
import { OneEuroFilter } from "../src/gaze/oneEuro";
import { projectGaze, type EyeParams } from "../src/gaze/geometry";
import { fitCalibration, predictScreen, rejectOutliers, type CalSample } from "../src/gaze/calibration";
import { Stabilizer } from "../src/gaze/stabilizer";

function blank(): Pt[] {
  return Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
}

function eyeLandmarks(irisX: number, irisY: number): Pt[] {
  const lm = blank();
  lm[LEFT_EYE.outer] = { x: 0.4, y: 0.5 };
  lm[LEFT_EYE.inner] = { x: 0.5, y: 0.5 };
  lm[LEFT_EYE.upper] = { x: 0.45, y: 0.48 };
  lm[LEFT_EYE.lower] = { x: 0.45, y: 0.52 };
  lm[LEFT_EYE.iris] = { x: irisX, y: irisY };
  return lm;
}

describe("irisInEye", () => {
  it("is 0.5 when iris is centred", () => {
    const r = irisInEye(eyeLandmarks(0.45, 0.5), LEFT_EYE);
    expect(r.x).toBeCloseTo(0.5);
    expect(r.y).toBeCloseTo(0);
  });
  it("is scale invariant (face closer to camera)", () => {
    const a = irisInEye(eyeLandmarks(0.43, 0.505), LEFT_EYE);
    const big = eyeLandmarks(0.43, 0.505).map((p) => ({ x: p.x * 2, y: p.y * 2 }));
    const b = irisInEye(big, LEFT_EYE);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.y).toBeCloseTo(a.y);
  });
  it("gives the same vertical sign for both eyes (regression test for cancelling bug)", () => {
    const lm = blank();
    // image-left eye: outer at small x; image-right eye: outer at large x (axis points the other way)
    lm[LEFT_EYE.outer] = { x: 0.3, y: 0.5 };
    lm[LEFT_EYE.inner] = { x: 0.4, y: 0.5 };
    lm[LEFT_EYE.upper] = { x: 0.35, y: 0.48 };
    lm[LEFT_EYE.lower] = { x: 0.35, y: 0.52 };
    lm[LEFT_EYE.iris] = { x: 0.35, y: 0.51 }; // iris low
    lm[RIGHT_EYE.outer] = { x: 0.7, y: 0.5 };
    lm[RIGHT_EYE.inner] = { x: 0.6, y: 0.5 };
    lm[RIGHT_EYE.upper] = { x: 0.65, y: 0.48 };
    lm[RIGHT_EYE.lower] = { x: 0.65, y: 0.52 };
    lm[RIGHT_EYE.iris] = { x: 0.65, y: 0.51 }; // iris low
    expect(irisInEye(lm, LEFT_EYE).y).toBeGreaterThan(0);
    expect(irisInEye(lm, RIGHT_EYE).y).toBeGreaterThan(0);
  });
});

describe("headPose", () => {
  it("identity matrix is zero rotation", () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const p = headPose(I);
    expect(p.yaw).toBeCloseTo(0);
    expect(p.pitch).toBeCloseTo(0);
    expect(p.roll).toBeCloseTo(0);
  });
  it("recovers a pure yaw", () => {
    const a = 0.3, c = Math.cos(a), s = Math.sin(a);
    const m = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; // rotation about Y, column-major
    expect(headPose(m).yaw).toBeCloseTo(a);
  });
});

describe("regression", () => {
  it("solves a linear system", () => {
    expect(solve([[2, 1], [1, 3]], [3, 5])).toEqual([expect.closeTo(0.8), expect.closeTo(1.4)]);
  });
  it("learns a linear features->screen mapping", () => {
    const truth = (f: number[]): [number, number] => [1000 * f[0] + 200 * f[2] + 50, -800 * f[1] + 400];
    const samples = [];
    for (let i = 0; i < 200; i++) {
      const f = [Math.random(), Math.random(), Math.random()];
      samples.push({ features: f, target: truth(f) });
    }
    const m = fitGazeModel(samples, 1e-6);
    const [x, y] = predict(m, [0.3, 0.6, 0.1]);
    const [tx, ty] = truth([0.3, 0.6, 0.1]);
    expect(x).toBeCloseTo(tx, 0);
    expect(y).toBeCloseTo(ty, 0);
  });
  it("handles a constant (zero-variance) feature", () => {
    const samples = [0, 1, 2, 3].map((v) => ({ features: [v, 5], target: [v * 10, 0] as [number, number] }));
    const [x] = predict(fitGazeModel(samples, 1e-6), [1.5, 5]);
    expect(x).toBeCloseTo(15, 1);
  });
});

// ---------- synthetic head + eye model ----------
const TRUE_EYE: EyeParams = { cx: 0.5, cy: 0, kx: 2.5, ky: 2.5 };
const toScreen = (P: [number, number]): [number, number] => [800 + 40 * P[0], 450 - 40 * P[1]];
const toPlane = (s: [number, number]): [number, number] => [(s[0] - 800) / 40, (450 - s[1]) / 40];

function rotY(a: number): number[] {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Raw measurements a perfect tracker would produce for a head at t/yaw looking at screen point `target`. */
function synth(target: [number, number], t: [number, number, number], yaw: number): RawGaze {
  const R = rotY(yaw);
  const [px, py] = toPlane(target);
  const v = [px - t[0], py - t[1], -t[2]];
  const n = Math.hypot(v[0], v[1], v[2]);
  const d = v.map((x) => x / n);
  // head frame = Rᵀ d
  const hx = R[0] * d[0] + R[3] * d[1] + R[6] * d[2];
  const hy = R[1] * d[0] + R[4] * d[1] + R[7] * d[2];
  const hz = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];
  const eyeYaw = Math.atan2(hx, hz), eyePitch = Math.asin(hy);
  return {
    gx: TRUE_EYE.cx + eyeYaw / TRUE_EYE.kx,
    gy: TRUE_EYE.cy - eyePitch / TRUE_EYE.ky,
    lookV: 0,
    R,
    t,
  };
}

describe("projectGaze", () => {
  it("round-trips the synthetic model", () => {
    const target: [number, number] = [1200, 200];
    const g = synth(target, [3, -2, -55], 0.1);
    const P = projectGaze(g, TRUE_EYE);
    expect(toScreen(P)[0]).toBeCloseTo(1200, 3);
    expect(toScreen(P)[1]).toBeCloseTo(200, 3);
  });
  it("is independent of where the head is (same target, different head positions)", () => {
    const a = projectGaze(synth([400, 600], [0, 0, -50], 0), TRUE_EYE);
    const b = projectGaze(synth([400, 600], [8, 4, -60], -0.25), TRUE_EYE);
    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });
});

describe("fitCalibration", () => {
  function calSamples(): CalSample[] {
    const out: CalSample[] = [];
    const xs = [130, 800, 1470], ys = [90, 450, 810];
    for (const y of ys)
      for (const x of xs)
        for (let i = 0; i < 25; i++) out.push({ raw: synth([x, y], [0, 0, -50], 0), target: [x, y] });
    // head phase: eyes on centre dot, head moves
    for (let i = 0; i < 100; i++) {
      const a = Math.sin(i / 8);
      out.push({ raw: synth([800, 450], [a * 4, Math.cos(i / 5) * 2, -50], a * 0.2), target: [800, 450] });
    }
    return out;
  }

  it("fits accurately and recovers the eye gain", () => {
    const cal = fitCalibration(calSamples());
    expect(cal.errorPx).toBeLessThan(15);
    expect(cal.eye.kx).toBe(2.5);
  });

  it("stays accurate after the head moves away from the calibration position", () => {
    const cal = fitCalibration(calSamples());
    const target: [number, number] = [1300, 300];
    const [x, y] = predictScreen(cal, synth(target, [6, 3, -55], 0.15));
    expect(Math.hypot(x - target[0], y - target[1])).toBeLessThan(60);
  });

  it("drops glance outliers", () => {
    const good = Array.from({ length: 20 }, (_, i) => ({
      raw: { ...synth([800, 450], [0, 0, -50], 0), gx: 0.5 + (i % 3) * 0.001 },
      target: [800, 450] as [number, number],
    }));
    const glance = { raw: { ...good[0].raw, gx: 0.9 }, target: [800, 450] as [number, number] };
    expect(rejectOutliers([...good, glance])).toHaveLength(20);
  });
});

describe("OneEuroFilter", () => {
  it("smooths jitter around a still point", () => {
    const f = new OneEuroFilter(1, 0);
    let out = 0;
    for (let i = 0; i < 100; i++) out = f.filter(100 + (i % 2 ? 5 : -5), i * 33);
    expect(Math.abs(out - 100)).toBeLessThan(3);
  });
  it("converges to a new position", () => {
    const f = new OneEuroFilter(1, 0.05);
    let out = 0;
    for (let i = 0; i < 60; i++) out = f.filter(i < 10 ? 0 : 500, i * 33);
    expect(out).toBeGreaterThan(490);
  });
});

describe("Stabilizer", () => {
  it("holds still under ±20 px jitter and single-frame spikes", () => {
    const s = new Stabilizer();
    let first: [number, number] | null = null, last: [number, number] = [0, 0];
    for (let i = 0; i < 90; i++) {
      const spike = i % 17 === 0 ? 300 : 0;
      last = s.push(500 + (i % 2 ? 20 : -20) + spike, 400, i * 33);
      if (i === 30) first = last;
    }
    expect(Math.hypot(last[0] - first![0], last[1] - first![1])).toBeLessThan(5);
  });
  it("follows a real jump to a new tile", () => {
    const s = new Stabilizer();
    let out: [number, number] = [0, 0];
    for (let i = 0; i < 120; i++) out = s.push(i < 30 ? 200 : 1200, 400, i * 33);
    expect(out[0]).toBeGreaterThan(1150);
  });
});
