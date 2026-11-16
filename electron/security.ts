// Security rules of the desktop app, as small pure functions (unit tested in tests/security.test.ts).
// Nothing here imports Electron, so the same rules protect the dev server (vite.config.ts).
// Background reading: Electron security checklist — https://www.electronjs.org/docs/latest/tutorial/security
// AI-assisted: written with help from Claude (Anthropic).
import path from "node:path";

// ---------- where the interface is loaded from ----------
/** The interface is served from this private origin only (custom protocol, not file:// or http://). */
export const APP_ORIGIN = "app://signalspeak";

export function isAppUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "app:" && u.host === "signalspeak";
  } catch {
    return false;
  }
}

/**
 * Content Security Policy for the interface.
 *  - scripts: only our own files; 'wasm-unsafe-eval' lets the MediaPipe WebAssembly module compile
 *    (it does NOT allow eval of JavaScript)
 *  - connect: only our own origin — the page cannot send camera data (or anything else) to the internet
 *  - no plugins, no framing, no form posts, no <base> tricks
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
};

/**
 * Map a request path to a file inside `root`. Returns null for anything that would escape the folder
 * (../, absolute paths, drive letters, encoded tricks) or has a file type we don't ship.
 */
export function resolveAsset(root: string, urlPath: string): { file: string; mime: string } | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes("\0") || rel.includes("\\")) return null;
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
  const inside = path.relative(path.resolve(root), file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return null;
  const mime = MIME[path.extname(file).toLowerCase()];
  return mime ? { file, mime } : null;
}

// ---------- input validation ----------
/** Text that will be spoken / texted / pushed to the caregiver: a plain, bounded string. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") throw new Error("text expected");
  // control characters (incl. newlines) could forge extra lines in a notification or header
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) throw new Error("empty text");
  return s.slice(0, max);
}

export const isCallSid = (v: unknown): v is string => typeof v === "string" && /^CA[0-9a-f]{32}$/.test(v);

/** One-time acknowledge code (crypto.randomUUID()). */
export const isNonce = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

/** ntfy tags are emoji short-codes: short lowercase words. */
export function cleanTags(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("tags must be a list");
  return v.filter((t): t is string => typeof t === "string" && /^[a-z0-9_]{1,32}$/.test(t)).slice(0, 5);
}

// ---------- configuration (caregiver-provided secrets) ----------
export interface Config {
  /** ntfy topic — acts as a shared password between this app and the caregiver's phone */
  ntfyTopic: string | null;
  twilio: { sid: string; token: string; from: string; to: string } | null;
  /** start SignalSpeak when the user signs in to Windows (the user cannot launch it themselves) */
  autoStart: boolean;
}

/** Parse KEY=value lines (the .env format). Unknown keys are ignored; values lose stray whitespace. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").replace(/\s/g, "");
  }
  return out;
}

/**
 * A topic anyone could guess lets strangers alert the caregiver — or read the alerts.
 * Require 20+ characters and refuse the placeholder from .env.example.
 */
export const isStrongTopic = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(v) && !/change-?me|example|test$/i.test(v);

const isPhone = (v: unknown): v is string => typeof v === "string" && /^\+[1-9]\d{7,14}$/.test(v);

/** Validate raw settings. Anything malformed is dropped (that feature is then "not configured"). */
export function toConfig(env: Record<string, string>): { config: Config; problems: string[] } {
  const problems: string[] = [];
  const topic = env.NTFY_TOPIC ?? env.VITE_NTFY_TOPIC;
  let ntfyTopic: string | null = null;
  if (topic) {
    if (isStrongTopic(topic)) ntfyTopic = topic;
    else problems.push("NTFY_TOPIC must be 20–64 letters/digits/-/_ and hard to guess — push notifications are off");
  }
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from, CAREGIVER_PHONE: to } = env;
  let twilio: Config["twilio"] = null;
  if (sid || token || from || to) {
    if (/^AC[0-9a-f]{32}$/.test(sid ?? "") && /^[0-9a-f]{32}$/.test(token ?? "") && isPhone(from) && isPhone(to)) twilio = { sid, token, from, to };
    else problems.push("Twilio settings are incomplete or malformed — phone call and text are off");
  }
  return { config: { ntfyTopic, twilio, autoStart: /^(1|true|yes)$/i.test(env.AUTO_START ?? "") }, problems };
}

// ---------- rate limiting ----------
/**
 * Sliding-window limiter. Limits are far above real use (an alarm makes 1 call) — they exist so that
 * a bug or a compromised page cannot run up the phone bill or bombard the caregiver.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

// ---------- dev server only ----------
/**
 * The dev server's API must only answer the page it served. Checks that defeat a malicious website
 * open in another tab (CSRF) and DNS rebinding:
 *  - Host header is a loopback name (a rebinding attack arrives with the attacker's host name)
 *  - Origin, when the browser sends one, is that same loopback origin
 *  - the body is declared as JSON (cross-site pages can't send that without a CORS preflight,
 *    which the server never approves)
 */
export function isLocalRequest(h: { host?: string; origin?: string; contentType?: string }): boolean {
  const host = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.exec(h.host ?? "");
  if (!host) return false;
  if (h.origin !== undefined && h.origin !== `http://${h.host}`) return false;
  return /^application\/json\b/i.test(h.contentType ?? "");
}
