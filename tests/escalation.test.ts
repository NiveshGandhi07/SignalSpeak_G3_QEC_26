// Tests for the emergency escalation state machine. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { classifyCall, idle, secondsLeft, step, type EscEvent, type EscState } from "../src/emergency/escalation";

const T = { minWaitMs: 10_000, maxWaitMs: 30_000 };
const run = (s: EscState, ...events: EscEvent[]) => events.reduce((st, e) => step(st, e, T).state, s);
const started = () => run(idle(), { type: "start", now: 0 });

describe("emergency escalation", () => {
  it("start sends the push and calls the caregiver", () => {
    const r = step(idle(), { type: "start", now: 1000 }, T);
    expect(r.state.phase).toBe("waiting");
    expect(r.effects).toEqual(["notifyPush", "callCaregiver"]);
    expect(secondsLeft(r.state, 1000, T)).toBe(30);
  });

  it("no response at all -> text + 911 after the max wait, exactly once", () => {
    const s = started();
    expect(step(s, { type: "tick", now: 29_999 }, T).effects).toEqual([]);
    const r = step(s, { type: "tick", now: 30_000 }, T);
    expect(r.state.phase).toBe("escalated");
    expect(r.effects).toEqual(["sendText", "call911"]);
    expect(step(r.state, { type: "tick", now: 60_000 }, T).effects).toEqual([]);
  });

  it("unanswered call escalates early, but never before the min wait", () => {
    const s = run(started(), { type: "callUnanswered" });
    expect(secondsLeft(s, 4000, T)).toBe(6);
    expect(step(s, { type: "tick", now: 9_999 }, T).effects).toEqual([]);
    expect(step(s, { type: "tick", now: 10_000 }, T).effects).toEqual(["sendText", "call911"]);
  });

  it("answering the phone counts as a response", () => {
    const s = run(started(), { type: "callAnswered" }, { type: "tick", now: 60_000 });
    expect(s.phase).toBe("acknowledged");
  });

  it("tapping 'I'm on my way' stops escalation and hangs up the call", () => {
    const r = step(started(), { type: "ack" }, T);
    expect(r.state.phase).toBe("acknowledged");
    expect(r.effects).toEqual(["endCall"]);
    expect(step(r.state, { type: "tick", now: 60_000 }, T).effects).toEqual([]);
  });

  it("a late response after escalation doesn't undo the 911 call", () => {
    const s = run(started(), { type: "tick", now: 30_000 });
    expect(run(s, { type: "ack" }, { type: "callAnswered" }).phase).toBe("escalated");
  });

  it("patient cancel hangs up, resets, and tells the caregiver", () => {
    const r = step(started(), { type: "cancel" }, T);
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toEqual(["endCall", "notifyCancelled"]);
    expect(step(idle(), { type: "cancel" }, T).effects).toEqual([]);
  });

  it("starting twice doesn't double-notify", () => {
    expect(step(started(), { type: "start", now: 5 }, T).effects).toEqual([]);
  });
});

describe("classifyCall", () => {
  it.each([
    ["queued", null, "pending"],
    ["ringing", null, "pending"],
    ["in-progress", null, "pending"], // waiting for human/machine detection
    ["in-progress", "human", "answered"],
    ["in-progress", "unknown", "answered"],
    ["completed", null, "answered"],
    ["in-progress", "machine_start", "unanswered"], // voicemail
    ["completed", "machine_end_beep", "unanswered"],
    ["no-answer", null, "unanswered"],
    ["busy", null, "unanswered"],
    ["failed", null, "unanswered"],
    ["canceled", null, "unanswered"],
  ])("%s / %s -> %s", (status, answeredBy, expected) => {
    expect(classifyCall(status, answeredBy)).toBe(expected);
  });

  it("without voicemail detection (trial), a connected call is never treated as answered", () => {
    // voicemail picking up looks identical to a person answering, so only the ntfy ack counts
    expect(classifyCall("in-progress", null, false)).toBe("pending");
    expect(classifyCall("ringing", null, false)).toBe("pending");
  });

  it("without detection, a call that ends unconfirmed (e.g. voicemail) counts as unanswered", () => {
    expect(classifyCall("completed", null, false)).toBe("unanswered");
    expect(classifyCall("no-answer", null, false)).toBe("unanswered");
  });

  it("voicemail on a trial call: countdown keeps running and escalates", () => {
    // simulate: call connects to voicemail at 8 s (pending), voicemail hangs up at 25 s (unanswered)
    let s = step(idle(), { type: "start", now: 0 }).state;
    expect(classifyCall("in-progress", null, false)).toBe("pending"); // no callAnswered dispatched
    s = step(s, { type: "callUnanswered" }).state; // at 25 s, call completed
    expect(step(s, { type: "tick", now: 25_000 }).effects).toEqual(["sendText", "call911"]);
  });
});
