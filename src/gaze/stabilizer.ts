// Cursor stabilisation: median-of-N (kills single-frame spikes) -> One Euro filter
// (smooth when still, responsive on saccades) -> dead zone (cursor stays put during fixations).
// AI-assisted: written with help from Claude (Anthropic).
import { OneEuroFilter } from "./oneEuro";
import { median } from "./calibration";

export interface StabilizerOptions {
  window: number; // median window (frames)
  minCutoff: number; // One Euro: lower = smoother at rest
  beta: number; // One Euro: higher = less lag when moving
  deadZone: number; // px; small movements inside this radius are ignored
}

export const DEFAULT_STABILIZER: StabilizerOptions = { window: 5, minCutoff: 0.4, beta: 0.004, deadZone: 40 };

export class Stabilizer {
  private hx: number[] = [];
  private hy: number[] = [];
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private out: [number, number] | null = null;
  private o: StabilizerOptions;

  constructor(o: StabilizerOptions = DEFAULT_STABILIZER) {
    this.o = o;
    this.fx = new OneEuroFilter(o.minCutoff, o.beta);
    this.fy = new OneEuroFilter(o.minCutoff, o.beta);
  }

  push(x: number, y: number, tMs: number): [number, number] {
    this.hx.push(x);
    this.hy.push(y);
    if (this.hx.length > this.o.window) {
      this.hx.shift();
      this.hy.shift();
    }
    const sx = this.fx.filter(median(this.hx), tMs);
    const sy = this.fy.filter(median(this.hy), tMs);
    if (!this.out) {
      this.out = [sx, sy];
    } else {
      const dx = sx - this.out[0], dy = sy - this.out[1];
      const d = Math.hypot(dx, dy);
      if (d > this.o.deadZone) {
        // move only the part beyond the dead zone -> no jump at the boundary
        const k = (d - this.o.deadZone) / d;
        this.out = [this.out[0] + dx * k, this.out[1] + dy * k];
      }
    }
    return this.out;
  }

  reset(): void {
    this.hx = [];
    this.hy = [];
    this.fx.reset();
    this.fy.reset();
    this.out = null;
  }
}
