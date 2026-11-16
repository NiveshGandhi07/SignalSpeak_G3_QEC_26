// Tests for the selectable emergency gestures. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { applyBind, createEmergencyDetector, DEFAULT_BINDS, parseBinds, type GestureEvent } from "../src/events/emergencyGesture";
import type { BrowParams } from "../src/events/brow";

const BROW: BrowParams = { baseline: 0.1, high: 0.3, low: 0.2 };
const OPEN = 0.05, SHUT = 0.9, REST = 0.1, RAISED = 0.5;

/** Segments of [blink, brow, durationMs] sampled every 33 ms; returns the events emitted. */
function run(det: ReturnType<typeof createEmergencyDetector>, segs: [number, number, number][]): GestureEvent[] {
  const out: GestureEvent[] = [];
  let t = 0;
  for (const [blink, brow, ms] of segs) {
    for (const end = t + ms; t < end; t += 33) {
      const r = det.step(blink, brow, t);
      if (r.event !== "none") out.push(r.event);
    }
  }
  return out;
}

describe("bind: eyes closed + 3 brow raises", () => {
  const det = () => createEmergencyDetector("closedBrowRaises", BROW);
  const raise: [number, number, number][] = [[SHUT, RAISED, 300], [SHUT, REST, 300]];

  it("three raises with eyes closed trigger, with progress chirps on the first two", () => {
    expect(run(det(), [[OPEN, REST, 300], [SHUT, REST, 400], ...raise, ...raise, ...raise])).toEqual(["progress", "progress", "trigger"]);
  });
  it("opening the eyes early starts the count over", () => {
    const d = det();
    expect(run(d, [[SHUT, REST, 400], ...raise, ...raise, [OPEN, REST, 500]])).toEqual(["progress", "progress"]);
    expect(run(d, [[SHUT, REST, 400], ...raise])).toEqual(["progress"]); // count restarted at 1
  });
  it("brow raises with eyes open never count", () => {
    expect(run(det(), [[OPEN, RAISED, 300], [OPEN, REST, 300], [OPEN, RAISED, 300], [OPEN, REST, 300], [OPEN, RAISED, 300]])).toEqual([]);
  });
  it("holding the brows up is one raise, not many", () => {
    expect(run(det(), [[SHUT, REST, 400], [SHUT, RAISED, 3000]])).toEqual(["progress"]);
  });
  it("falls back to two long blinks when the user has no usable brow raise", () => {
    const d = createEmergencyDetector("closedBrowRaises", null);
    expect(d.bind).toBe("twoLongBlinks");
  });
});

describe("bind: two 3-second closes", () => {
  const det = () => createEmergencyDetector("twoLongCloses", null);
  it("two ≥3 s closures within 5 s trigger", () => {
    expect(run(det(), [[SHUT, REST, 3200], [OPEN, REST, 2000], [SHUT, REST, 3200], [OPEN, REST, 200]])).toEqual(["progress", "trigger"]);
  });
  it("ordinary long blinks (1–3 s) do not count for this bind", () => {
    expect(run(det(), [[SHUT, REST, 1500], [OPEN, REST, 500], [SHUT, REST, 1500], [OPEN, REST, 200]])).toEqual([]);
  });
  it("a gap longer than 5 s between closes does not trigger", () => {
    expect(run(det(), [[SHUT, REST, 3200], [OPEN, REST, 6000], [SHUT, REST, 3200], [OPEN, REST, 200]])).toEqual(["progress", "progress"]);
  });
  it("dozing off (very long closure) does not count", () => {
    expect(run(det(), [[SHUT, REST, 12_000], [OPEN, REST, 500], [SHUT, REST, 12_000], [OPEN, REST, 500]])).toEqual([]);
  });
});

describe("bind: two long blinks (default)", () => {
  it("still works through the unified detector", () => {
    const d = createEmergencyDetector("twoLongBlinks", BROW);
    expect(d.needed).toBe(2);
    expect(run(d, [[SHUT, REST, 1300], [OPEN, REST, 600], [SHUT, REST, 1300], [OPEN, REST, 200]])).toEqual(["progress", "trigger"]);
  });
});

describe("parseBinds", () => {
  it("accepts known binds and falls back on junk", () => {
    expect(parseBinds({ emergency: "twoLongCloses", calibrate: "closedBrowRaises", painCheck: false })).toEqual({ emergency: "twoLongCloses", calibrate: "closedBrowRaises", painCheck: false });
    expect(parseBinds({ emergency: "nope", calibrate: 7 })).toEqual(DEFAULT_BINDS);
    expect(parseBinds(null)).toEqual({ emergency: "twoLongBlinks", calibrate: "twoLongCloses", painCheck: true });
  });
  it("migrates old saved binds (emergency only) to the default recalibrate gesture", () => {
    expect(parseBinds({ emergency: "closedBrowRaises" })).toEqual({ emergency: "closedBrowRaises", calibrate: "twoLongCloses", painCheck: true });
  });
  it("never lets one gesture do both jobs — Emergency wins", () => {
    expect(parseBinds({ emergency: "twoLongCloses" })).toMatchObject({ emergency: "twoLongCloses", calibrate: "off" });
  });
});

describe("applyBind", () => {
  it("changes the recalibrate gesture, or turns it off", () => {
    expect(applyBind(DEFAULT_BINDS, "calibrate", "closedBrowRaises")).toEqual({ ...DEFAULT_BINDS, calibrate: "closedBrowRaises" });
    expect(applyBind(DEFAULT_BINDS, "calibrate", "off").calibrate).toBe("off");
  });
  it("refuses to reuse the emergency gesture for recalibrate (same object back)", () => {
    expect(applyBind(DEFAULT_BINDS, "calibrate", "twoLongBlinks")).toBe(DEFAULT_BINDS);
  });
  it("refuses to reuse the recalibrate gesture for Emergency too (exclusive both ways)", () => {
    expect(applyBind(DEFAULT_BINDS, "emergency", "twoLongCloses")).toBe(DEFAULT_BINDS);
    expect(applyBind(DEFAULT_BINDS, "emergency", "closedBrowRaises")).toEqual({ ...DEFAULT_BINDS, emergency: "closedBrowRaises" });
  });
  it("once Recalibrate is off, Emergency may take any gesture", () => {
    const off = applyBind(DEFAULT_BINDS, "calibrate", "off");
    expect(applyBind(off, "emergency", "twoLongCloses").emergency).toBe("twoLongCloses");
  });
  it("after any sequence of changes the two binds never share a gesture", () => {
    const keys = ["emergency", "calibrate"] as const;
    const vals = ["twoLongBlinks", "twoLongCloses", "closedBrowRaises", "off"] as const;
    let b = DEFAULT_BINDS;
    for (let i = 0; i < 200; i++) {
      b = applyBind(b, keys[(i * 7) % 2], vals[(i * 5 + (i >> 2)) % 4]);
      expect(b.emergency).not.toBe(b.calibrate);
    }
  });
  it("Emergency can never be turned off", () => {
    expect(applyBind(DEFAULT_BINDS, "emergency", "off")).toBe(DEFAULT_BINDS);
  });
});

describe("recalibrate and emergency detectors side by side (default binds)", () => {
  it("two 3-second closes fire recalibrate but not emergency", () => {
    const segs: [number, number, number][] = [[SHUT, REST, 3200], [OPEN, REST, 1500], [SHUT, REST, 3200], [OPEN, REST, 200]];
    expect(run(createEmergencyDetector("twoLongCloses", BROW), segs)).toContain("trigger");
    expect(run(createEmergencyDetector("twoLongBlinks", BROW), segs)).toEqual([]);
  });
  it("two long blinks fire emergency but not recalibrate", () => {
    const segs: [number, number, number][] = [[SHUT, REST, 1300], [OPEN, REST, 600], [SHUT, REST, 1300], [OPEN, REST, 200]];
    expect(run(createEmergencyDetector("twoLongBlinks", BROW), segs)).toContain("trigger");
    expect(run(createEmergencyDetector("twoLongCloses", BROW), segs)).toEqual([]);
  });
});
