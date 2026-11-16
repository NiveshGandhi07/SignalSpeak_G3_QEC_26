// Emergency escalation state machine (pure — unit tested).
//   start             -> "waiting": push notification + phone call to the caregiver
//   ack / call answered -> "acknowledged": caregiver responded, stop escalating
//   call unanswered   -> escalate as soon as MIN_WAIT has passed (gives the push a fair chance)
//   MAX_WAIT elapsed with no response -> "escalated": text the caregiver + SIMULATED 911 call
//   cancel            -> "idle": patient said "I'm OK"
// AI-assisted: written with help from Claude (Anthropic).

export type Phase = "idle" | "waiting" | "acknowledged" | "escalated";

export interface EscState {
  phase: Phase;
  startedAt: number;
  /** the phone call ended without a human answering (or could not be placed) */
  callFailed: boolean;
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

export const DEFAULT_TIMING: Timing = { minWaitMs: 10_000, maxWaitMs: 30_000 };

export const idle = (): EscState => ({ phase: "idle", startedAt: 0, callFailed: false });

const same = (state: EscState) => ({ state, effects: [] as Effect[] });

export function step(s: EscState, e: EscEvent, t: Timing = DEFAULT_TIMING): { state: EscState; effects: Effect[] } {
  switch (e.type) {
    case "start":
      if (s.phase !== "idle") return same(s); // already running
      return { state: { phase: "waiting", startedAt: e.now, callFailed: false }, effects: ["notifyPush", "callCaregiver"] };
    case "tick": {
      if (s.phase !== "waiting") return same(s);
      const elapsed = e.now - s.startedAt;
      if (elapsed >= t.maxWaitMs || (s.callFailed && elapsed >= t.minWaitMs))
        return { state: { ...s, phase: "escalated" }, effects: ["sendText", "call911"] };
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
export function secondsLeft(s: EscState, now: number, t: Timing = DEFAULT_TIMING): number {
  if (s.phase !== "waiting") return 0;
  const deadline = s.callFailed ? t.minWaitMs : t.maxWaitMs;
  return Math.max(0, Math.ceil((deadline - (now - s.startedAt)) / 1000));
}

export type CallOutcome = "pending" | "answered" | "unanswered";

/**
 * Interpret Twilio call status + answering-machine detection.
 * Statuses: https://www.twilio.com/docs/voice/api/call-resource#call-status-values
 * Voicemail (AnsweredBy = machine_* / fax) does NOT count as the caregiver answering.
 *
 * Without detection (Twilio trial accounts can't enable it), a connected call can't be told apart
 * from voicemail picking up, so it never counts as answered: only the caregiver tapping
 * "I'm on my way" (ntfy) stops the 911 countdown. A call that ends unconfirmed counts as unanswered,
 * so voicemail escalates as soon as the minimum wait has passed.
 */
export function classifyCall(status: string, answeredBy?: string | null, detection = true): CallOutcome {
  const machine = !!answeredBy && (answeredBy.startsWith("machine") || answeredBy === "fax");
  if (["busy", "failed", "no-answer", "canceled"].includes(status)) return "unanswered";
  if (status === "in-progress" || status === "completed") {
    if (machine) return "unanswered";
    if (!detection) return status === "completed" ? "unanswered" : "pending"; // human or voicemail? unknown
    // with detection enabled, wait for Twilio to decide human vs machine
    if (status === "in-progress" && !answeredBy) return "pending";
    return "answered";
  }
  return "pending"; // queued / initiated / ringing
}
