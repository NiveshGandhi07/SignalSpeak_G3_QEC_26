// Vite config (Vite, MIT — https://vite.dev).
// Adds POST /api/open (open a macro's website/app with the OS — see macroOpener below) and
// small server-side endpoints (dev + preview server) for emergency phone alerts via Twilio:
//   POST /api/sms        {body}    -> text the caregiver      (Messages API)
//   POST /api/call       {script}  -> call the caregiver, read the script aloud (Calls API + TwiML <Say>)
//   GET  /api/call?sid=  -> {status, answeredBy}               (poll whether the caregiver answered)
//   POST /api/call/end   {sid}     -> hang up / cancel the call
// Twilio docs: https://www.twilio.com/docs/messaging/api/message-resource
//              https://www.twilio.com/docs/voice/api/call-resource
//              https://www.twilio.com/docs/voice/twiml/say
// Credentials come from .env.local (git-ignored) and never reach the browser.
// Note: Twilio trial accounts are restricted (e.g. texts limited to predefined templates; trial calls
// play a Twilio message first). The ntfy push notification works regardless.
// AI-assisted: written with help from Claude (Anthropic).
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { findMacro } from "./src/macros/catalog.ts";

type Res = ServerResponse;

const TRIAL_VOICE_TEMPLATE = "https://webhooks.twilio.com/v1/Voice/Template/voice_text_to_speech";

function twilioRelay(env: Record<string, string>): Plugin {
  const val = (k: string) => (env[k] ?? "").replace(/\s/g, ""); // tolerate stray spaces in .env.local
  const sid = val("TWILIO_ACCOUNT_SID"), token = val("TWILIO_AUTH_TOKEN");
  const from = val("TWILIO_FROM"), to = val("CAREGIVER_PHONE");
  const configured = !!(sid && token && from && to);
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const auth = { Authorization: "Basic " + btoa(`${sid}:${token}`) };

  const reply = (res: Res, status: number, data: object) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  };
  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const twilio = async (path: string, form?: Record<string, string>) => {
    const r = await fetch(`${base}${path}`, {
      method: form ? "POST" : "GET",
      headers: form ? { ...auth, "Content-Type": "application/x-www-form-urlencoded" } : auth,
      body: form ? new URLSearchParams(form) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data.code === 572006 ? "Twilio trial can't send custom texts (upgrade needed)" : `Twilio ${r.status}: ${data.message ?? ""}`;
      throw new Error(msg);
    }
    return data;
  };
  const escapeXml = (s: string) =>
    s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

  const routes: Record<string, (req: IncomingMessage, res: Res, url: URL) => Promise<void>> = {
    "POST /api/sms": async (req, res) => {
      const { body } = await readJson(req);
      await twilio("/Messages.json", { To: to, From: from, Body: String(body ?? "").slice(0, 600) });
      reply(res, 200, { ok: true });
    },
    "POST /api/call": async (req, res) => {
      const { script } = await readJson(req);
      const twiml = `<Response><Pause length="1"/><Say voice="alice" loop="3">${escapeXml(String(script ?? "").slice(0, 500))}</Say></Response>`;
      try {
        const call = await twilio("/Calls.json", {
          To: to,
          From: from,
          Twiml: twiml,
          Timeout: "20", // seconds to ring before "no-answer"
          MachineDetection: "Enable", // so voicemail doesn't count as the caregiver answering
        });
        reply(res, 200, { sid: call.sid, detection: true, trial: false });
      } catch (e) {
        if (!/trial accounts have limited parameter access/i.test((e as Error).message)) throw e;
        // Trial accounts may only pass `To` + one of Twilio's sample call URLs (verified 2026-11-14):
        // https://www.twilio.com/docs/usage/trials/try-out-voice — the call plays Twilio's sample speech,
        // not our script, and has no voicemail detection. Upgrading the account restores the full call.
        const call = await twilio("/Calls.json", { To: to, Url: TRIAL_VOICE_TEMPLATE });
        reply(res, 200, { sid: call.sid, detection: false, trial: true });
      }
    },
    "GET /api/call": async (_req, res, url) => {
      const callSid = url.searchParams.get("sid") ?? "";
      if (!/^CA[0-9a-f]{32}$/.test(callSid)) return reply(res, 400, { error: "bad sid" });
      const call = await twilio(`/Calls/${callSid}.json`);
      reply(res, 200, { status: call.status, answeredBy: call.answered_by ?? null });
    },
    "POST /api/call/end": async (req, res) => {
      const { sid: callSid } = await readJson(req);
      if (!/^CA[0-9a-f]{32}$/.test(String(callSid))) return reply(res, 400, { error: "bad sid" });
      await twilio(`/Calls/${callSid}.json`, { Status: "completed" }).catch(() =>
        twilio(`/Calls/${callSid}.json`, { Status: "canceled" }), // still ringing -> cancel
      );
      reply(res, 200, { ok: true });
    },
  };

  const middleware = async (req: IncomingMessage, res: Res, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return next();
    if (!configured) return reply(res, 501, { error: "Twilio not configured in .env.local" });
    try {
      await route(req, res, url);
    } catch (e) {
      reply(res, 502, { error: (e as Error).message });
    }
  };

  return {
    name: "twilio-relay",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

/**
 * POST /api/open {macroId} — opens a website / app from the macro catalogue with the operating system.
 * Only catalogue entries can be opened (looked up server-side), and arguments are passed to spawn()
 * as an array without a shell, so the browser can't inject commands.
 */
function macroOpener(): Plugin {
  const APPS: Record<string, Record<string, [string, string[]]>> = {
    win32: { calculator: ["calc.exe", []], notepad: ["notepad.exe", []] },
    darwin: { calculator: ["open", ["-a", "Calculator"]], notepad: ["open", ["-a", "TextEdit"]] },
    linux: { calculator: ["gnome-calculator", []], notepad: ["gedit", []] },
  };
  const urlOpener: Record<string, string> = { win32: "explorer.exe", darwin: "open", linux: "xdg-open" };

  const middleware = (req: IncomingMessage, res: Res, next: () => void) => {
    if (req.method !== "POST" || req.url !== "/api/open") return next();
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, data: object) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      };
      let macroId = "";
      try {
        macroId = String(JSON.parse(raw).macroId ?? "");
      } catch {
        /* handled below */
      }
      const macro = findMacro(macroId);
      if (!macro) return send(404, { error: "unknown macro" });
      const plat = process.platform;
      let cmd: [string, string[]] | undefined;
      if (macro.target.kind === "url") {
        const u = new URL(macro.target.url);
        if (u.protocol !== "https:") return send(400, { error: "only https links" });
        cmd = urlOpener[plat] ? [urlOpener[plat], [u.href]] : undefined;
      } else {
        cmd = APPS[plat]?.[macro.target.app];
      }
      if (!cmd) return send(501, { error: `not supported on ${plat}` });
      try {
        spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
        send(200, { ok: true });
      } catch (e) {
        send(500, { error: (e as Error).message });
      }
    });
  };
  return {
    name: "macro-opener",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ""); // "" = also load non-VITE_ (server-only) vars
  return { plugins: [twilioRelay(env), macroOpener()] };
});
