// Tests for the caregiver-configurable escalation policy. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, describePolicy, parsePolicy } from "../src/emergency/policy";
import { classifyCall, idle, secondsLeft, step, type EscEvent, type EscState } from "../src/emergency/escalation";
import type { EscalationPolicy } from "../src/emergency/policy";

const run = (p: Partial<EscalationPolicy>, s: EscState, ...events: EscEvent[]) =>
  events.reduce((acc, e) => {
    const r = step(acc.state, e, p);
    return { state: r.state, effects: [...acc.effects, ...r.effects] };
  }, { state: s, effects: [] as string[] });

describe("parsePolicy", () => {
  it("empty config = the original behaviour", () => {
    expect(parsePolicy({})).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY).toEqual({
      callCaregiver: true,
      textOnEscalation: true,
      call911: "after-no-response",
      minWaitMs: 10_000,
      maxWaitMs: 30_000,
      callAnswerCounts: "auto",
    });
  });

  it("reads every setting", () => {
    expect(
      parsePolicy({
        ESCALATION_CALL_CAREGIVER: "false",
        ESCALATION_TEXT: "no",
        ESCALATION_911: "immediately",
        ESCALATION_WAIT_SECONDS: "60",
        ESCALATION_MIN_WAIT_SECONDS: "20",
        ESCALATION_CALL_ANSWER_COUNTS: "Never",
      }),
    ).toEqual({ callCaregiver: false, textOnEscalation: false, call911: "immediately", minWaitMs: 20_000, maxWaitMs: 60_000, callAnswerCounts: "never" });
  });

  it("falls back to the default on typos and out-of-range values", () => {
    const p = parsePolicy({ ESCALATION_TEXT: "maybe", ESCALATION_911: "soon", ESCALATION_WAIT_SECONDS: "2", ESCALATION_CALL_ANSWER_COUNTS: "sometimes" });
    expect(p).toEqual(DEFAULT_POLICY);
    expect(parsePolicy({ ESCALATION_WAIT_SECONDS: "abc" }).maxWaitMs).toBe(30_000);
    expect(parsePolicy({ ESCALATION_WAIT_SECONDS: "" }).maxWaitMs).toBe(30_000);
  });

  it("never lets the minimum wait exceed the wait", () => {
    expect(parsePolicy({ ESCALATION_WAIT_SECONDS: "15", ESCALATION_MIN_WAIT_SECONDS: "60" })).toMatchObject({ maxWaitMs: 15_000, minWaitMs: 15_000 });
  });

  it("describes the policy in one line", () => {
    expect(describePolicy(DEFAULT_POLICY)).toBe("notify + call caregiver; 911 after 30 s without a response; text if no response");
  });
});

describe("escalation with a policy", () => {
  it("default policy behaves exactly as before", () => {
    const r = run({}, idle(), { type: "start", now: 0 }, { type: "tick", now: 30_000 });
    expect(r.effects).toEqual(["notifyPush", "callCaregiver", "sendText", "call911"]);
    expect(r.state.phase).toBe("escalated");
  });

  it("no phone call: push only, then escalate at the wait time", () => {
    const r = run({ callCaregiver: false }, idle(), { type: "start", now: 0 }, { type: "tick", now: 30_000 });
    expect(r.effects).toEqual(["notifyPush", "sendText", "call911"]);
  });

  it("no text: escalation is only the 911 call", () => {
    expect(run({ textOnEscalation: false }, idle(), { type: "start", now: 0 }, { type: "tick", now: 30_000 }).effects).toEqual([
      "notifyPush",
      "callCaregiver",
      "call911",
    ]);
  });

  it("911 immediately: called at start alongside the caregiver, and never twice", () => {
    const start = run({ call911: "immediately" }, idle(), { type: "start", now: 0 });
    expect(start.effects).toEqual(["notifyPush", "callCaregiver", "call911"]);
    const later = run({ call911: "immediately" }, start.state, { type: "tick", now: 30_000 }, { type: "tick", now: 60_000 });
    expect(later.effects).toEqual(["sendText"]); // caregiver still didn't respond -> text, but no second 911
  });

  it("911 immediately, caregiver responds: no text", () => {
    const r = run({ call911: "immediately" }, idle(), { type: "start", now: 0 }, { type: "ack" }, { type: "tick", now: 60_000 });
    expect(r.effects).toEqual(["notifyPush", "callCaregiver", "call911", "endCall"]);
    expect(r.state.phase).toBe("acknowledged");
  });

  it("custom wait times drive both escalation and the countdown", () => {
    const p = { minWaitMs: 20_000, maxWaitMs: 60_000 };
    const s = run(p, idle(), { type: "start", now: 0 }).state;
    expect(secondsLeft(s, 0, p)).toBe(60);
    expect(run(p, s, { type: "tick", now: 59_999 }).effects).toEqual([]);
    expect(run(p, s, { type: "tick", now: 60_000 }).effects).toContain("call911");
    const unanswered = run(p, s, { type: "callUnanswered" }).state;
    expect(run(p, unanswered, { type: "tick", now: 19_999 }).effects).toEqual([]);
    expect(run(p, unanswered, { type: "tick", now: 20_000 }).effects).toContain("call911");
  });
});

describe("what stops the countdown (ESCALATION_CALL_ANSWER_COUNTS)", () => {
  it("auto (default): answering counts only with voicemail detection", () => {
    expect(classifyCall("in-progress", "human", true, "auto")).toBe("answered");
    expect(classifyCall("in-progress", null, false, "auto")).toBe("pending");
    expect(classifyCall("completed", null, false, "auto")).toBe("unanswered");
  });
  it("always: any connected call counts, even on a trial line", () => {
    expect(classifyCall("in-progress", null, false, "always")).toBe("answered");
    expect(classifyCall("completed", null, false, "always")).toBe("answered");
  });
  it("never: only the ntfy tap counts, even with detection", () => {
    expect(classifyCall("in-progress", "human", true, "never")).toBe("pending");
    expect(classifyCall("completed", "human", true, "never")).toBe("unanswered");
  });
  it("detected voicemail never counts, whatever the setting", () => {
    for (const c of ["auto", "always", "never"] as const) expect(classifyCall("in-progress", "machine_start", true, c)).toBe("unanswered");
  });
});
