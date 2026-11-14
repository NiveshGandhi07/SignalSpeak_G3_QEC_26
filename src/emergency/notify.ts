// Caregiver notifications.
//  1) Push notification via ntfy.sh (free, open-source, no account/API key) — https://ntfy.sh, https://docs.ntfy.sh
//     The caregiver installs the ntfy app and subscribes to VITE_NTFY_TOPIC. The notification carries an
//     "I'm on my way" button that POSTs to `<topic>-ack`; the app listens on that topic (Server-Sent Events).
//  2) Phone call + SMS via our own /api endpoints (vite.config.ts), which relay to Twilio using
//     credentials that stay on the local server (never shipped to the browser or committed).
// AI-assisted: written with help from Claude (Anthropic).

const NTFY = "https://ntfy.sh";
const TOPIC: string | undefined = import.meta.env.VITE_NTFY_TOPIC;

export interface Alert {
  title: string;
  message: string;
  /** emergency look: highest priority + siren tag. Otherwise `priority` (default 3 = normal). */
  urgent?: boolean;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  /** include the "I'm on my way" acknowledge button */
  askAck?: boolean;
}

/** Run a channel and turn the result into a short status line (never throws). */
export async function attempt(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return `Failed: ${(e as Error).message}`;
  }
}

export async function sendPush(a: Alert): Promise<string> {
  if (!TOPIC) throw new Error("push not configured (VITE_NTFY_TOPIC)");
  const res = await fetch(NTFY, {
    method: "POST",
    body: JSON.stringify({
      topic: TOPIC,
      title: a.title,
      message: a.message,
      priority: a.urgent ? 5 : (a.priority ?? 3),
      tags: a.tags ?? (a.urgent ? ["rotating_light"] : ["information_source"]),
      actions: a.askAck
        ? [{ action: "http", label: "I'm on my way", url: `${NTFY}/${TOPIC}-ack`, method: "POST", body: "ack", clear: true }]
        : [],
    }),
  });
  if (!res.ok) throw new Error(`push failed (${res.status})`);
  return "Push sent";
}

async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error ?? String(res.status));
  return data as T;
}

export async function sendText(body: string): Promise<string> {
  await api("/api/sms", { body }).catch((e) => Promise.reject(new Error(`SMS: ${e.message}`)));
  return "Text sent";
}

export interface PlacedCall {
  sid: string;
  /** answering-machine detection is on (false on Twilio trial accounts) */
  detection: boolean;
  /** trial account: Twilio's sample message plays instead of our script */
  trial: boolean;
}

/** Starts a phone call that reads `script` aloud (or Twilio's sample message on a trial account). */
export function placeCall(script: string): Promise<PlacedCall> {
  return api<PlacedCall>("/api/call", { script }).catch((e) => Promise.reject(new Error(`call: ${e.message}`)));
}

export function callStatus(sid: string): Promise<{ status: string; answeredBy: string | null }> {
  return api(`/api/call?sid=${encodeURIComponent(sid)}`);
}

export function endCall(sid: string): Promise<unknown> {
  return api("/api/call/end", { sid }).catch(() => undefined);
}

/** Listen for the caregiver tapping "I'm on my way". Returns an unsubscribe function. */
export function listenForAck(onAck: () => void): () => void {
  if (!TOPIC || typeof EventSource === "undefined") return () => {};
  const es = new EventSource(`${NTFY}/${TOPIC}-ack/sse`);
  es.onmessage = (ev) => {
    try {
      if (JSON.parse(ev.data).event === "message") onAck();
    } catch {
      /* ignore keepalives / malformed */
    }
  };
  return () => es.close();
}
