// Emergency escalation state machine (pure — unit tested). Behaviour is set by an EscalationPolicy
// (emergency/policy.ts, chosen by a caregiver in the config file); the defaults are:
//   start             -> "waiting": push notification + phone call to the caregiver
//   ack / call answered -> "acknowledged": caregiver responded, stop escalating
//   call unanswered   -> escalate as soon as minWait has passed (gives the push a fair chance)
//   maxWait elapsed with no response -> "escalated": text the caregiver + SIMULATED 911 call
//   cancel            -> "idle": patient said "I'm OK"
// With call911 = "immediately", the simulated 911 call happens at start, alongside the caregiver.
// AI-assisted: written with help from Claude (Anthropic).
import { DEFAULT_POLICY, type AnswerCounts, type EscalationPolicy } from "./policy";

export type Phase = "idle" | "waiting" | "acknowledged" | "escalated";

export interface EscState {
  phase: Phase;
  startedAt: number;
  /** the phone call ended without a human answering (or could not be placed) */
  callFailed: boolean;
  /** the simulated 911 call has already happened (so it is never repeated) */
  called911: boolean;
}

export type EscEvent =
  | { type: "start"; now: number }
  | { type: "tick"; now: number }
  | { type: "ack" }
  | { type: "callAnswered" }
  | { type: "callUnanswered" }
  | { type: "cancel" };

export type Effect = "notifyPush" | "callCaregiver" | "sendText" | "call911" | "notifyCancelled" | "endCall";

export interface Timing {
  minWaitMs: number; // never escalate before this
  maxWaitMs: number; // always escalate after this if nobody responded
}

export const DEFAULT_TIMING: Timing = { minWaitMs: DEFAULT_POLICY.minWaitMs, maxWaitMs: DEFAULT_POLICY.maxWaitMs };

export const idle = (): EscState => ({ phase: "idle", startedAt: 0, callFailed: false, called911: false });

const same = (state: EscState) => ({ state, effects: [] as Effect[] });

/** `p` may be a full policy or just the parts to override (e.g. only the timing). */
export function step(s: EscState, e: EscEvent, p: Partial<EscalationPolicy> = {}): { state: EscState; effects: Effect[] } {
  const pol: EscalationPolicy = { ...DEFAULT_POLICY, ...p };
  switch (e.type) {
    case "start": {
      if (s.phase !== "idle") return same(s); // already running
      const now911 = pol.call911 === "immediately";
      const effects: Effect[] = ["notifyPush"];
      if (pol.callCaregiver) effects.push("callCaregiver");
      if (now911) effects.push("call911");
      return { state: { phase: "waiting", startedAt: e.now, callFailed: false, called911: now911 }, effects };
    }
    case "tick": {
      if (s.phase !== "waiting") return same(s);
      const elapsed = e.now - s.startedAt;
      if (elapsed >= pol.maxWaitMs || (s.callFailed && elapsed >= pol.minWaitMs)) {
        const effects: Effect[] = [];
        if (pol.textOnEscalation) effects.push("sendText");
        if (!s.called911) effects.push("call911");
        return { state: { ...s, phase: "escalated", called911: true }, effects };
      }
      return same(s);
    }
    case "ack":
    case "callAnswered":
      if (s.phase !== "waiting") return same(s);
      // ack from the push means the phone call is no longer needed
      return { state: { ...s, phase: "acknowledged" }, effects: e.type === "ack" ? ["endCall"] : [] };
    case "callUnanswered":
      return s.phase === "waiting" ? same({ ...s, callFailed: true }) : same(s);
    case "cancel":
      return s.phase === "idle" ? same(s) : { state: idle(), effects: ["endCall", "notifyCancelled"] };
  }
}

/** Seconds until escalation (for the on-screen countdown). */
export function secondsLeft(s: EscState, now: number, p: Partial<Timing> = {}): number {
  const t = { ...DEFAULT_TIMING, ...p };
  if (s.phase !== "waiting") return 0;
  const deadline = s.callFailed ? t.minWaitMs : t.maxWaitMs;
  return Math.max(0, Math.ceil((deadline - (now - s.startedAt)) / 1000));
}

export type CallOutcome = "pending" | "answered" | "unanswered";

/**
 * Interpret Twilio call status + answering-machine detection.
 * Statuses: https://www.twilio.com/docs/voice/api/call-resource#call-status-values
 * Voicemail (AnsweredBy = machine_* / fax) never counts as the caregiver answering.
 *
 * `counts` (policy ESCALATION_CALL_ANSWER_COUNTS):
 *   auto   — answering counts only when voicemail detection is on. Without it (Twilio trial accounts),
 *            a connected call can't be told apart from voicemail, so it never counts: only the
 *            "I'm on my way" tap stops the countdown, and a call that ends unconfirmed is unanswered.
 *   always — any connected call counts (trial voicemail would count too).
 *   never  — answering never counts; only the "I'm on my way" tap stops the countdown.
 */
export function classifyCall(
  status: string,
  answeredBy?: string | null,
  detection = true,
  counts: AnswerCounts = DEFAULT_POLICY.callAnswerCounts,
): CallOutcome {
  const machine = !!answeredBy && (answeredBy.startsWith("machine") || answeredBy === "fax");
  if (["busy", "failed", "no-answer", "canceled"].includes(status)) return "unanswered";
  if (status === "in-progress" || status === "completed") {
    if (machine) return "unanswered";
    if (counts === "never" || (counts === "auto" && !detection)) {
      return status === "completed" ? "unanswered" : "pending"; // only the ntfy tap confirms
    }
    // with detection enabled, wait for Twilio to decide human vs machine
    if (detection && status === "in-progress" && !answeredBy) return "pending";
    return "answered";
  }
  return "pending"; // queued / initiated / ringing
}
