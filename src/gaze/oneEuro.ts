// One Euro Filter — adaptive low-pass filter for noisy pointer signals.
// Algorithm from: G. Casiez, N. Roussel, D. Vogel, "1€ Filter: A Simple Speed-based Low-pass
// Filter for Noisy Input in Interactive Systems", CHI 2012. https://gery.casiez.net/1euro/
// Implementation written with help from Claude (Anthropic).

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  /**
   * @param minCutoff lower = smoother when still (Hz)
   * @param beta higher = less lag when moving fast
   */
  minCutoff: number;
  beta: number;
  dCutoff: number;

  constructor(minCutoff = 1.0, beta = 0.01, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = tMs;
      return value;
    }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}
