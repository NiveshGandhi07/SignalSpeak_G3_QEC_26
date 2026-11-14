// Per-user gaze calibration (pure).
// 1. Drop outlier frames per calibration target (median ± 3·MAD).
// 2. Grid-search eye gains (kx, ky); for each, fit a quadratic ridge regression
//    from the projected gaze point to screen pixels; keep the lowest error.
//    The "head" phase (eyes fixed on one dot while the head moves) is what lets the
//    search find gains that cancel head motion.
// AI-assisted: written with help from Claude (Anthropic).
import type { RawGaze } from "./features";
import { projectGaze, type EyeParams } from "./geometry";
import { fitGazeModel, predict, type GazeModel } from "./regression";

export interface CalSample {
  raw: RawGaze;
  target: [number, number];
}

export interface Calibration {
  eye: EyeParams;
  reg: GazeModel;
  /** mean error (px) on the calibration targets, using per-target medians */
  errorPx: number;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function groupByTarget(samples: CalSample[]): CalSample[][] {
  const groups = new Map<string, CalSample[]>();
  for (const s of samples) {
    const key = s.target.join(",");
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.values()];
}

/** Remove frames whose iris reading is far from that target's median (glances, tracking glitches). */
export function rejectOutliers(samples: CalSample[]): CalSample[] {
  return groupByTarget(samples).flatMap((g) => {
    const keep = (vals: number[]) => {
      const med = median(vals);
      const mad = median(vals.map((v) => Math.abs(v - med))) || 1e-6;
      return vals.map((v) => Math.abs(v - med) <= 3 * mad);
    };
    const okX = keep(g.map((s) => s.raw.gx));
    const okY = keep(g.map((s) => s.raw.gy));
    return g.filter((_, i) => okX[i] && okY[i]);
  });
}

export function features(raw: RawGaze, eye: EyeParams): number[] {
  const [px, py] = projectGaze(raw, eye);
  return [px, py, px * py, px * px, py * py, raw.lookV];
}

export function predictScreen(cal: Calibration, raw: RawGaze): [number, number] {
  return predict(cal.reg, features(raw, cal.eye));
}

const GAINS = [-3, -2, 1.5, 2, 2.5, 3, 3.5, 4];

export function fitCalibration(all: CalSample[], gains = GAINS): Calibration {
  const samples = rejectOutliers(all);
  if (samples.length < 20) throw new Error("not enough calibration data — is the face visible?");
  const cx = median(samples.map((s) => s.raw.gx));
  const cy = median(samples.map((s) => s.raw.gy));

  let best: { eye: EyeParams; reg: GazeModel; score: number } | null = null;
  for (const kx of gains) {
    for (const ky of gains) {
      const eye = { cx, cy, kx, ky };
      const rows = samples.map((s) => ({ features: features(s.raw, eye), target: s.target }));
      const reg = fitGazeModel(rows, 1e-3);
      let se = 0;
      for (const r of rows) {
        const [x, y] = predict(reg, r.features);
        se += (x - r.target[0]) ** 2 + (y - r.target[1]) ** 2;
      }
      // slight preference for anatomically plausible gains when the data can't tell them apart
      const prior = 1 + 0.01 * ((kx - 2.5) ** 2 + (ky - 2.5) ** 2);
      const score = Math.sqrt(se / rows.length) * prior;
      if (!best || score < best.score) best = { eye, reg, score };
    }
  }

  const cal = { eye: best!.eye, reg: best!.reg, errorPx: 0 };
  const errs = groupByTarget(samples).map((g) => {
    const xs: number[] = [], ys: number[] = [];
    for (const s of g) {
      const [x, y] = predictScreen(cal, s.raw);
      xs.push(x);
      ys.push(y);
    }
    return Math.hypot(median(xs) - g[0].target[0], median(ys) - g[0].target[1]);
  });
  cal.errorPx = errs.reduce((a, b) => a + b, 0) / errs.length;
  return cal;
}
