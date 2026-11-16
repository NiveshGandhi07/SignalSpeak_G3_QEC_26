// Pain check: a sustained grimace (brows pulled down, eyes squeezed, nose wrinkled, mouth corners
// down) makes the app ask "Are you in pain?" — someone who can't speak may not think to, or be able to,
// navigate to the Pain tile while hurting.
// Signal: MediaPipe blendshapes browDown*, eyeSquint*, noseSneer*, mouthFrown* [6].
// Personalised: the detector learns this user's resting level and natural variation (a face can look
// "pained" at rest, especially with ALS facial weakness), so it reacts to a change, not a fixed level.
// Pure state machine — unit tested.
// AI-assisted: written with help from Claude (Anthropic).
import type { Blendshape } from "../gaze/features";

const bs = (shapes: Blendshape[], name: string) => shapes.find((s) => s.categoryName === name)?.score ?? 0;
const pair = (shapes: Blendshape[], name: string) => (bs(shapes, `${name}Left`) + bs(shapes, `${name}Right`)) / 2;

/** 0..1, higher = more grimace-like. */
export function grimaceScore(shapes: Blendshape[]): number {
  return (pair(shapes, "browDown") + pair(shapes, "eyeSquint") + pair(shapes, "noseSneer") + pair(shapes, "mouthFrown")) / 4;
}

export interface GrimaceOptions {
  /** score must rise this far above the learned resting level (at least) */
  minDelta: number;
  /** ...and this many standard deviations of the user's own resting variation */
  sigmas: number;
  /** sustained this long before asking */
  holdMs: number;
  /** dips below the threshold shorter than this don't restart the hold */
  graceMs: number;
  /** don't ask again for this long after asking */
  cooldownMs: number;
  /** resting-level learning rate per frame (slow: ~30 s at 30 fps) */
  learnRate: number;
  /** frames with eyes more closed than this are ignored (blinks squint the eyes too) */
  blinkMax: number;
  /** frames needed to learn the resting level before the detector can fire */
  warmupFrames: number;
}

export const DEFAULT_GRIMACE: GrimaceOptions = {
  minDelta: 0.15,
  sigmas: 4,
  holdMs: 2500,
  graceMs: 300,
  cooldownMs: 3 * 60_000,
  learnRate: 0.002,
  blinkMax: 0.45,
  warmupFrames: 90,
};

export interface GrimaceState {
  mean: number;
  variance: number;
  frames: number;
  aboveSince: number | null;
  lastAbove: number;
  lastPrompt: number;
}

export const initialGrimace = (): GrimaceState => ({
  mean: 0,
  variance: 0,
  frames: 0,
  aboveSince: null,
  lastAbove: -Infinity,
  lastPrompt: -Infinity,
});

export function grimaceThreshold(s: GrimaceState, o: GrimaceOptions = DEFAULT_GRIMACE): number {
  return s.mean + Math.max(o.minDelta, o.sigmas * Math.sqrt(s.variance));
}

/** One frame. Returns prompt=true once when a grimace has been held long enough. */
export function stepGrimace(
  s: GrimaceState,
  score: number,
  blink: number,
  now: number,
  o: GrimaceOptions = DEFAULT_GRIMACE,
): { state: GrimaceState; prompt: boolean; level: number } {
  if (blink > o.blinkMax) return { state: s, prompt: false, level: 0 };

  // learn the resting level (fast average during warm-up, then slow exponential average)
  if (s.frames < o.warmupFrames) {
    const frames = s.frames + 1;
    const mean = s.mean + (score - s.mean) / frames;
    const variance = s.variance + ((score - s.mean) * (score - mean) - s.variance) / frames;
    return { state: { ...s, frames, mean, variance }, prompt: false, level: 0 };
  }

  const threshold = grimaceThreshold(s, o);
  const above = score >= threshold;
  const level = Math.min(1, Math.max(0, (score - s.mean) / (threshold - s.mean || 1e-6)));
  let next: GrimaceState = { ...s };
  if (!above) {
    // only resting frames update the baseline, so a long grimace doesn't become "normal"
    const d = score - s.mean;
    next.mean = s.mean + o.learnRate * d;
    next.variance = (1 - o.learnRate) * (s.variance + o.learnRate * d * d);
    if (s.aboveSince !== null && now - s.lastAbove > o.graceMs) next.aboveSince = null;
    return { state: next, prompt: false, level };
  }
  next.lastAbove = now;
  next.aboveSince = s.aboveSince ?? now;
  if (now - next.aboveSince >= o.holdMs && now - s.lastPrompt >= o.cooldownMs) {
    next = { ...next, aboveSince: null, lastPrompt: now };
    return { state: next, prompt: true, level };
  }
  return { state: next, prompt: false, level };
}
