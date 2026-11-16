// Emergency escalation policy: what happens after an emergency starts, set by a caregiver in the config
// file (the patient can't change safety settings by an accidental glance). Pure — unit tested.
// The defaults reproduce the original behaviour exactly.
//
// Config keys (all optional; invalid values fall back to the default):
//   ESCALATION_CALL_CAREGIVER       true | false                    phone-call the caregiver at the start   (default true)
//   ESCALATION_TEXT                 true | false                    text the caregiver when escalating      (default true)
//   ESCALATION_911                  after-no-response | immediately when the (simulated) 911 call happens  (default after-no-response)
//   ESCALATION_WAIT_SECONDS         5–300                           escalate after this long with no response (default 30)
//   ESCALATION_MIN_WAIT_SECONDS     0–300 (≤ wait)                  ...or this soon if the call was clearly not answered (default 10)
//   ESCALATION_CALL_ANSWER_COUNTS   auto | always | never           does answering the phone stop the countdown? (default auto)
//       auto   = only when voicemail detection is available (paid Twilio); trial lines need the ntfy tap
//       always = any connected call counts (on trial lines, voicemail would count too)
//       never  = only the "I'm on my way" tap counts
// AI-assisted: written with help from Claude (Anthropic).

export type Call911 = "after-no-response" | "immediately";
export type AnswerCounts = "auto" | "always" | "never";

export interface EscalationPolicy {
  callCaregiver: boolean;
  textOnEscalation: boolean;
  call911: Call911;
  minWaitMs: number;
  maxWaitMs: number;
  callAnswerCounts: AnswerCounts;
}

export const DEFAULT_POLICY: EscalationPolicy = {
  callCaregiver: true,
  textOnEscalation: true,
  call911: "after-no-response",
  minWaitMs: 10_000,
  maxWaitMs: 30_000,
  callAnswerCounts: "auto",
};

const bool = (v: string | undefined, d: boolean): boolean => {
  const s = v?.trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "on" || s === "1") return true;
  if (s === "false" || s === "no" || s === "off" || s === "0") return false;
  return d;
};

const seconds = (v: string | undefined, lo: number, hi: number, d: number): number => {
  const n = Number(v?.trim());
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 1000) : d;
};

const oneOf = <T extends string>(v: string | undefined, options: readonly T[], d: T): T => {
  const s = v?.trim().toLowerCase();
  return (options as readonly string[]).includes(s ?? "") ? (s as T) : d;
};

/** Build a policy from config key/values. Never throws; anything missing or invalid uses the default. */
export function parsePolicy(env: Record<string, string | undefined>): EscalationPolicy {
  const d = DEFAULT_POLICY;
  const maxWaitMs = seconds(env.ESCALATION_WAIT_SECONDS, 5, 300, d.maxWaitMs);
  const minWaitMs = Math.min(seconds(env.ESCALATION_MIN_WAIT_SECONDS, 0, 300, d.minWaitMs), maxWaitMs);
  return {
    callCaregiver: bool(env.ESCALATION_CALL_CAREGIVER, d.callCaregiver),
    textOnEscalation: bool(env.ESCALATION_TEXT, d.textOnEscalation),
    call911: oneOf(env.ESCALATION_911, ["after-no-response", "immediately"] as const, d.call911),
    minWaitMs,
    maxWaitMs,
    callAnswerCounts: oneOf(env.ESCALATION_CALL_ANSWER_COUNTS, ["auto", "always", "never"] as const, d.callAnswerCounts),
  };
}

/** One-line summary for the alarm screen / About card. */
export function describePolicy(p: EscalationPolicy): string {
  const contact = p.callCaregiver ? "notify + call caregiver" : "notify caregiver";
  const nine = p.call911 === "immediately" ? "911 called at once" : `911 after ${p.maxWaitMs / 1000} s without a response`;
  return `${contact}; ${nine}${p.textOnEscalation ? "; text if no response" : ""}`;
}
