// Caregiver notifications, as seen from the interface.
// The interface holds no credentials and makes no internet requests itself. It asks the trusted backend
// (electron/backend.ts) for one of the operations in ./api.ts:
//   - desktop app: through `window.signalspeak` (electron/preload.ts -> IPC -> main process)
//   - `npm run dev` in a browser: through POST /api/backend on the local dev server (vite.config.ts)
// Channels: push notification via ntfy (free, open-source — https://ntfy.sh) with an "I'm on my way"
// button; phone call + text via Twilio.
// AI-assisted: written with help from Claude (Anthropic).
import type { BackendApi, BackendMethod, PlacedCall, PushRequest } from "./api";

export type { PlacedCall } from "./api";
export type Alert = PushRequest;

declare global {
  interface Window {
    /** present only inside the desktop app */
    signalspeak?: BackendApi;
  }
}

async function http<T>(method: BackendMethod, payload: object): Promise<T> {
  const res = await fetch("/api/backend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, payload }),
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error ?? String(res.status));
  return data.result as T;
}

const devServer: BackendApi = {
  push: (a) => http("push", a),
  call: (script) => http("call", { script }),
  callStatus: (sid) => http("callStatus", { sid }),
  endCall: (sid) => http("endCall", { sid }),
  sms: (body) => http("sms", { body }),
  checkAck: (nonce, sinceUnix) => http("checkAck", { nonce, sinceUnix }),
  openMacro: (macroId) => http("openMacro", { macroId }),
};

export const backend: BackendApi = (typeof window !== "undefined" && window.signalspeak) || devServer;

/** Electron prefixes errors that cross the process boundary; show only the message itself. */
const tidy = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");

/** Run a channel and turn the result into a short status line (never throws). */
export async function attempt(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return `Failed: ${tidy(e)}`;
  }
}

/** One-time code tying an "I'm on my way" tap to one specific alert. */
export const newAckNonce = (): string => crypto.randomUUID();

export async function sendPush(a: Alert): Promise<string> {
  await backend.push(a);
  return "Push sent";
}

export async function sendText(body: string): Promise<string> {
  await backend.sms(body).catch((e) => Promise.reject(new Error(`SMS: ${tidy(e)}`)));
  return "Text sent";
}

/** Starts a phone call that reads `script` aloud (or Twilio's sample message on a trial account). */
export function placeCall(script: string): Promise<PlacedCall> {
  return backend.call(script).catch((e) => Promise.reject(new Error(tidy(e))));
}

export const callStatus = (sid: string) => backend.callStatus(sid);

export function endCall(sid: string): Promise<unknown> {
  return backend.endCall(sid).catch(() => undefined);
}

const ACK_POLL_MS = 3000;

/**
 * Wait for the caregiver to tap "I'm on my way" on the alert sent with `nonce`.
 * Returns a function that stops waiting. Network hiccups are ignored — the next poll tries again.
 */
export function listenForAck(nonce: string, onAck: () => void): () => void {
  const since = Math.floor(Date.now() / 1000) - 5; // small allowance for clock differences
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    backend
      .checkAck(nonce, since)
      .then((acked) => {
        if (!acked || stopped) return;
        stop();
        onAck();
      })
      .catch(() => {});
  }, ACK_POLL_MS);
  return stop;
}
