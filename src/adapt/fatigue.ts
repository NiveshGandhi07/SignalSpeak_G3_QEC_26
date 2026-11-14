// Fatigue-aware pacing (pure — unit tested).
// Watches three signs of tiring during a session:
//   1. selection latency  — how long it takes to select once on a tile (vs the user's own early baseline)
//   2. brow amplitude     — how high eyebrow raises go (vs the height measured at calibration)
//   3. undo rate          — how often the user cancels what they selected (mistakes)
// and turns them into a 0..1 fatigue score that slows the interface down, makes the brow trigger
// easier, and switches to look-and-hold when eyebrow raises are clearly failing.
// AI-assisted: written with help from Claude (Anthropic).

export interface Pacing {
  score: number; // 0 fresh .. 1 exhausted
  level: "fresh" | "tired" | "very tired";
  dwellMs: number;
  rearmMs: number;
  speakDelayMs: number;
  /** shorter undo window for quick answers (Yes / No) */
  quickSpeakDelayMs: number;
  /** multiply the calibrated brow thresholds by this (lower = smaller raise needed) */
  browThresholdScale: number;
  /** eyebrow raises are failing: use look-and-hold instead */
  preferDwell: boolean;
}

export interface FatigueOptions {
  baseDwellMs: number;
  baseRearmMs: number;
  baseSpeakDelayMs: number;
  baseQuickSpeakDelayMs: number;
  baselineCount: number; // first N selections define this user's normal latency
  alpha: number; // EWMA smoothing (higher = reacts faster)
  restResetMs: number; // a break this long lets the score recover
}

export const DEFAULT_FATIGUE: FatigueOptions = {
  baseDwellMs: 1500,
  baseRearmMs: 800,
  baseSpeakDelayMs: 2500,
  baseQuickSpeakDelayMs: 1500,
  baselineCount: 5,
  alpha: 0.25,
  restResetMs: 120_000,
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class FatigueTracker {
  private o: FatigueOptions;
  private early: number[] = [];
  private baseLatency: number | null = null;
  private latency: number | null = null; // EWMA
  private amplitude = 1; // EWMA of raise height / calibrated height
  private recent: boolean[] = []; // last 10 outcomes: true = undone
  private lastActivity: number | null = null;
  private dwellLocked = false;

  constructor(o: FatigueOptions = DEFAULT_FATIGUE) {
    this.o = o;
  }

  private touch(now: number): void {
    // a long break lets the user recover: pull the averages halfway back to normal
    if (this.lastActivity !== null && now - this.lastActivity >= this.o.restResetMs) {
      if (this.latency !== null && this.baseLatency !== null) this.latency = (this.latency + this.baseLatency) / 2;
      this.amplitude = (this.amplitude + 1) / 2;
      this.recent = this.recent.slice(-3);
    }
    this.lastActivity = now;
  }

  private push(undone: boolean): void {
    this.recent.push(undone);
    if (this.recent.length > 10) this.recent.shift();
  }

  /** A completed selection and how long it took (ms on the tile before selecting). */
  recordSelection(latencyMs: number, now: number): void {
    this.touch(now);
    this.push(false);
    if (this.baseLatency === null) {
      this.early.push(latencyMs);
      if (this.early.length >= this.o.baselineCount) {
        const s = [...this.early].sort((a, b) => a - b);
        this.baseLatency = s[s.length >> 1];
        this.latency = this.baseLatency;
      }
      return;
    }
    this.latency = this.latency! + this.o.alpha * (latencyMs - this.latency!);
  }

  /** Peak of an eyebrow raise as a fraction of the calibrated raise (1 = as high as at calibration). */
  recordBrowAmplitude(ratio: number, now: number): void {
    this.touch(now);
    this.amplitude += this.o.alpha * (clamp01(ratio) - this.amplitude);
  }

  /** The user cancelled a selection (likely a mistake). */
  recordUndo(now: number): void {
    this.touch(now);
    if (this.recent.length) this.recent[this.recent.length - 1] = true;
    else this.push(true);
  }

  components(): { latency: number; amplitude: number; undo: number } {
    const latency =
      this.latency !== null && this.baseLatency ? clamp01(this.latency / this.baseLatency - 1) : 0; // 2x slower = 1
    const amplitude = clamp01((0.9 - this.amplitude) / 0.5); // raises at 40% of calibrated height = 1
    const undos = this.recent.filter(Boolean).length;
    const undo = this.recent.length ? clamp01(undos / this.recent.length / 0.3) : 0; // 30% undone = 1
    return { latency, amplitude, undo };
  }

  score(): number {
    const c = this.components();
    return clamp01(0.4 * c.latency + 0.35 * c.amplitude + 0.25 * c.undo);
  }

  pacing(): Pacing {
    const score = this.score();
    const c = this.components();
    // switch to dwell when brows are clearly failing; switch back only once they've recovered (hysteresis)
    if (!this.dwellLocked && c.amplitude >= 0.8) this.dwellLocked = true;
    else if (this.dwellLocked && c.amplitude <= 0.3) this.dwellLocked = false;
    return {
      score,
      level: score < 0.33 ? "fresh" : score < 0.66 ? "tired" : "very tired",
      dwellMs: Math.round(this.o.baseDwellMs * (1 + score)),
      rearmMs: Math.round(this.o.baseRearmMs * (1 + score)),
      speakDelayMs: Math.round(this.o.baseSpeakDelayMs * (1 + 0.6 * score)),
      quickSpeakDelayMs: Math.round(this.o.baseQuickSpeakDelayMs * (1 + 0.6 * score)),
      browThresholdScale: 1 - 0.3 * score,
      preferDwell: this.dwellLocked,
    };
  }
}
