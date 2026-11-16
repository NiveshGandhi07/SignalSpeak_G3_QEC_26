// Trusted backend: the one place that holds the caregiver's credentials and talks to the network.
// The interface can only ask for the seven operations in src/emergency/api.ts; every request is
// validated and rate-limited here, whatever the page sends.
//   - Push + "I'm on my way" acknowledgement: ntfy.sh (https://docs.ntfy.sh/publish/, /subscribe/api/)
//   - Phone call + text: Twilio REST API
//       https://www.twilio.com/docs/voice/api/call-resource · https://www.twilio.com/docs/voice/twiml/say
//       https://www.twilio.com/docs/messaging/api/message-resource
//     Trial accounts are restricted (sample message instead of our script, no custom texts).
//   - Shortcuts: only entries of the macro catalogue can be opened.
// No Electron imports — runs in the Electron main process and in the Vite dev server.
// AI-assisted: written with help from Claude (Anthropic).
import { spawn } from "node:child_process";
import { BACKEND_METHODS, type BackendMethod, type CallState, type PlacedCall } from "../src/emergency/api.ts";
import { findMacro } from "../src/macros/catalog.ts";
import { cleanTags, cleanText, isCallSid, isNonce, RateLimiter, type Config } from "./security.ts";

const NTFY = "https://ntfy.sh";
const TRIAL_VOICE_TEMPLATE = "https://webhooks.twilio.com/v1/Voice/Template/voice_text_to_speech";
const TIMEOUT_MS = 15_000;
const WINDOW_MS = 10 * 60_000;

/** Requests allowed per 10 minutes. Polling operations are cheap and unbilled, so they get more. */
const LIMITS: Record<BackendMethod, number> = { push: 60, call: 10, sms: 10, endCall: 30, openMacro: 60, callStatus: 900, checkAck: 900 };

const APPS: Record<string, Record<string, [string, string[]]>> = {
  win32: { calculator: ["calc.exe", []], notepad: ["notepad.exe", []] },
  darwin: { calculator: ["open", ["-a", "Calculator"]], notepad: ["open", ["-a", "TextEdit"]] },
  linux: { calculator: ["gnome-calculator", []], notepad: ["gedit", []] },
};

export interface BackendDeps {
  config: Config;
  /** open an https link in the user's browser */
  openUrl: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  platform?: string;
  launch?: (cmd: string, args: string[]) => void;
}

export interface Backend {
  /** Run one operation. Throws an Error with a short, secret-free message on any problem. */
  handle(method: unknown, payload: unknown): Promise<unknown>;
}

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function createBackend(deps: BackendDeps): Backend {
  const { config } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const launch = deps.launch ?? ((cmd, args) => void spawn(cmd, args, { detached: true, stdio: "ignore", shell: false }).on("error", () => {}).unref());
  const limiters = new Map(BACKEND_METHODS.map((m) => [m, new RateLimiter(LIMITS[m], WINDOW_MS)]));
  /** calls placed by this run of the app — the page can only query or end these */
  const ourCalls = new Set<string>();

  const request = (url: string, init?: RequestInit) => doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });

  async function twilio(path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
    const t = config.twilio;
    if (!t) throw new Error("phone not configured");
    const auth = { Authorization: "Basic " + Buffer.from(`${t.sid}:${t.token}`).toString("base64") };
    const r = await request(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}${path}`, {
      method: form ? "POST" : "GET",
      headers: form ? { ...auth, "Content-Type": "application/x-www-form-urlencoded" } : auth,
      body: form ? new URLSearchParams(form) : undefined,
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      // short fixed messages: Twilio's own text can echo account details
      if (data.code === 572006) throw new Error("Twilio trial can't send custom texts (upgrade needed)");
      if (/trial accounts have limited parameter access/i.test(String(data.message ?? ""))) throw new TrialLimit();
      throw new Error(`Twilio error ${r.status}${typeof data.code === "number" ? ` (code ${data.code})` : ""}`);
    }
    return data;
  }

  const ops: Record<BackendMethod, (p: Record<string, unknown>) => Promise<unknown>> = {
    async push(p) {
      const topic = config.ntfyTopic;
      if (!topic) throw new Error("push not configured");
      const urgent = p.urgent === true;
      const priority = urgent ? 5 : [1, 2, 3, 4, 5].includes(p.priority as number) ? (p.priority as number) : 3;
      const tags = cleanTags(p.tags);
      if (p.ackNonce !== undefined && !isNonce(p.ackNonce)) throw new Error("bad acknowledge code");
      const body = {
        topic,
        title: cleanText(p.title, 80),
        message: cleanText(p.message, 500),
        priority,
        tags: tags.length ? tags : [urgent ? "rotating_light" : "information_source"],
        actions: p.ackNonce
          ? [{ action: "http", label: "I'm on my way", url: `${NTFY}/${topic}-ack`, method: "POST", body: `ack:${p.ackNonce}`, clear: true }]
          : [],
      };
      const r = await request(NTFY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`push failed (${r.status})`);
    },

    async checkAck(p) {
      const topic = config.ntfyTopic;
      if (!topic) return false;
      if (!isNonce(p.nonce)) throw new Error("bad acknowledge code");
      const since = Number(p.sinceUnix);
      if (!Number.isInteger(since) || since < 0) throw new Error("bad time");
      const r = await request(`${NTFY}/${topic}-ack/json?poll=1&since=${since}`);
      if (!r.ok) throw new Error(`acknowledge check failed (${r.status})`);
      return ackReceived(await r.text(), p.nonce);
    },

    async call(p): Promise<PlacedCall> {
      const t = config.twilio;
      if (!t) throw new Error("phone not configured");
      const script = cleanText(p.script, 500);
      const twiml = `<Response><Pause length="1"/><Say voice="alice" loop="3">${escapeXml(script)}</Say></Response>`;
      let placed: PlacedCall;
      try {
        // Timeout = seconds to ring; MachineDetection so voicemail doesn't count as the caregiver answering
        const c = await twilio("/Calls.json", { To: t.to, From: t.from, Twiml: twiml, Timeout: "20", MachineDetection: "Enable" });
        placed = { sid: String(c.sid), detection: true, trial: false };
      } catch (e) {
        if (!(e instanceof TrialLimit)) throw e;
        // Trial accounts may only pass `To` + one of Twilio's sample URLs:
        // https://www.twilio.com/docs/usage/trials/try-out-voice — plays Twilio's sample speech.
        const c = await twilio("/Calls.json", { To: t.to, Url: TRIAL_VOICE_TEMPLATE });
        placed = { sid: String(c.sid), detection: false, trial: true };
      }
      if (!isCallSid(placed.sid)) throw new Error("unexpected reply from Twilio");
      ourCalls.add(placed.sid);
      return placed;
    },

    async callStatus(p): Promise<CallState> {
      const sid = ownCall(p.sid);
      const c = await twilio(`/Calls/${sid}.json`);
      return { status: String(c.status ?? "unknown"), answeredBy: typeof c.answered_by === "string" ? c.answered_by : null };
    },

    async endCall(p) {
      const sid = ownCall(p.sid);
      await twilio(`/Calls/${sid}.json`, { Status: "completed" }).catch(() => twilio(`/Calls/${sid}.json`, { Status: "canceled" })); // still ringing -> cancel
    },

    async sms(p) {
      const t = config.twilio;
      if (!t) throw new Error("phone not configured");
      await twilio("/Messages.json", { To: t.to, From: t.from, Body: cleanText(p.body, 600) });
    },

    async openMacro(p) {
      const macro = typeof p.macroId === "string" ? findMacro(p.macroId) : undefined;
      if (!macro) throw new Error("unknown shortcut"); // only catalogue entries, looked up here
      if (macro.target.kind === "url") {
        const u = new URL(macro.target.url);
        if (u.protocol !== "https:") throw new Error("only https links");
        return deps.openUrl(u.href);
      }
      const cmd = APPS[platform]?.[macro.target.app];
      if (!cmd) throw new Error(`not supported on ${platform}`);
      launch(cmd[0], cmd[1]); // fixed program + fixed arguments, no shell
    },
  };

  function ownCall(sid: unknown): string {
    if (!isCallSid(sid) || !ourCalls.has(sid)) throw new Error("unknown call");
    return sid;
  }

  return {
    async handle(method, payload) {
      if (typeof method !== "string" || !BACKEND_METHODS.includes(method as BackendMethod)) throw new Error("unknown operation");
      const m = method as BackendMethod;
      if (!limiters.get(m)!.allow(m, now())) throw new Error("too many requests — try again in a few minutes");
      return ops[m](obj(payload));
    },
  };
}

class TrialLimit extends Error {}

/**
 * Did the caregiver's "I'm on my way" for THIS alert arrive? `ndjson` is ntfy's poll reply (one JSON
 * message per line). Only a message carrying this alert's one-time code counts, so an old tap, a tap
 * for another alert, or a stranger posting "ack" to the topic can't cancel an escalation.
 */
export function ackReceived(ndjson: string, nonce: string): boolean {
  return ndjson.split("\n").some((line) => {
    try {
      const m = JSON.parse(line) as { event?: unknown; message?: unknown };
      return m.event === "message" && m.message === `ack:${nonce}`;
    } catch {
      return false;
    }
  });
}
