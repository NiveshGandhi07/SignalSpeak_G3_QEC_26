// Pure ridge regression: gaze features -> screen (x, y).
// Standardises each feature, then solves (XᵀX + λI) w = Xᵀy by Gaussian elimination.
// AI-assisted: written with help from Claude (Anthropic).

export interface Sample {
  features: number[];
  target: [number, number]; // screen px
}

export interface GazeModel {
  mean: number[];
  std: number[];
  wx: number[]; // [bias, ...weights]
  wy: number[];
}

export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function fitGazeModel(samples: Sample[], lambda = 1e-2): GazeModel {
  if (samples.length === 0) throw new Error("no calibration samples");
  const d = samples[0].features.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const s of samples) s.features.forEach((v, j) => (mean[j] += v / samples.length));
  for (const s of samples) s.features.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / samples.length));
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;

  const rows = samples.map((s) => [1, ...s.features.map((v, j) => (v - mean[j]) / std[j])]);
  const n = d + 1;
  const XtX = Array.from({ length: n }, () => new Array(n).fill(0));
  const Xty = new Array(n).fill(0);
  const Xtx2 = new Array(n).fill(0);
  rows.forEach((x, i) => {
    for (let a = 0; a < n; a++) {
      Xty[a] += x[a] * samples[i].target[0];
      Xtx2[a] += x[a] * samples[i].target[1];
      for (let b = 0; b < n; b++) XtX[a][b] += x[a] * x[b];
    }
  });
  for (let a = 1; a < n; a++) XtX[a][a] += lambda * samples.length; // don't penalise bias
  return { mean, std, wx: solve(XtX, Xty), wy: solve(XtX, Xtx2) };
}

export function predict(m: GazeModel, f: number[]): [number, number] {
  let x = m.wx[0], y = m.wy[0];
  for (let j = 0; j < f.length; j++) {
    const z = (f[j] - m.mean[j]) / m.std[j];
    x += m.wx[j + 1] * z;
    y += m.wy[j + 1] * z;
  }
  return [x, y];
}
