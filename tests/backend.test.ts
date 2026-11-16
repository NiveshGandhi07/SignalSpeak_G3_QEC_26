// Tests for the trusted backend, with the network replaced by a fake. Nothing here contacts ntfy or
// Twilio. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { ackReceived, createBackend } from "../electron/backend";
import type { Config } from "../electron/security";

const TOPIC = "signalspeak-k3v9q2m8x7w4z1";
const TOKEN = "fedcba9876543210".repeat(2);
const CONFIG: Config = {
  ntfyTopic: TOPIC,
  twilio: { sid: "AC" + "0123456789abcdef".repeat(2), token: TOKEN, from: "+15550001111", to: "+15550002222" },
  autoStart: false,
};
const NONCE = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const SID = "CA" + "0af1".repeat(8);

interface Sent {
  url: string;
  method: string;
  body: string;
}

/** Backend wired to a fake network: `reply(url, body)` decides each response. */
function setup(reply: (url: string, body: string) => { status?: number; json?: unknown; text?: string } = () => ({ json: {} }), config = CONFIG) {
  const sent: Sent[] = [];
  const opened: string[] = [];
  const launched: string[] = [];
  let clock = 0;
  const backend = createBackend({
    config,
    openUrl: async (u) => void opened.push(u),
    launch: (cmd) => void launched.push(cmd),
    platform: "win32",
    now: () => clock,
    fetch: (async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      sent.push({ url, method: init?.method ?? "GET", body });
      const r = reply(url, body);
      return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
    }) as typeof fetch,
  });
  return { backend, sent, opened, launched, tick: (ms: number) => (clock += ms) };
}

describe("backend: what the interface may ask for", () => {
  it("refuses anything that isn't one of the seven operations", async () => {
    const { backend, sent } = setup();
    for (const m of ["eval", "readFile", "__proto__", "constructor", "", 7, null]) await expect(backend.handle(m, {})).rejects.toThrow("unknown operation");
    expect(sent).toHaveLength(0);
  });
  it("survives junk payloads", async () => {
    const { backend } = setup();
    for (const p of [null, undefined, "x", 5, [1, 2]]) await expect(backend.handle("sms", p)).rejects.toThrow();
  });
});

describe("backend: push + acknowledge", () => {
  it("sends the alert with an acknowledge button carrying the one-time code", async () => {
    const { backend, sent } = setup();
    await backend.handle("push", { title: "EMERGENCY", message: "Help", urgent: true, ackNonce: NONCE });
    expect(sent[0].url).toBe("https://ntfy.sh");
    const body = JSON.parse(sent[0].body);
    expect(body).toMatchObject({ topic: TOPIC, title: "EMERGENCY", message: "Help", priority: 5 });
    expect(body.actions[0]).toMatchObject({ url: `https://ntfy.sh/${TOPIC}-ack`, body: `ack:${NONCE}` });
  });
  it("the interface cannot choose the topic or the acknowledge address", async () => {
    const { backend, sent } = setup();
    await backend.handle("push", { title: "t", message: "m", topic: "attacker-topic", actions: [{ url: "https://evil.example" }], url: "https://evil.example" });
    const body = JSON.parse(sent[0].body);
    expect(body.topic).toBe(TOPIC);
    expect(body.actions).toEqual([]);
    expect(sent[0].body).not.toContain("evil");
  });
  it("cleans text and rejects a malformed acknowledge code", async () => {
    const { backend, sent } = setup();
    await backend.handle("push", { title: "a\nb", message: "x".repeat(2000) });
    const body = JSON.parse(sent[0].body);
    expect(body.title).toBe("a b");
    expect(body.message).toHaveLength(500);
    await expect(backend.handle("push", { title: "t", message: "m", ackNonce: "ack" })).rejects.toThrow();
  });
  it("only an acknowledgement with this alert's code counts", () => {
    const line = (message: string, event = "message") => JSON.stringify({ event, message });
    expect(ackReceived(line(`ack:${NONCE}`), NONCE)).toBe(true);
    expect(ackReceived([line("ack"), line("ack:11111111-2222-3333-4444-555555555555"), "not json", ""].join("\n"), NONCE)).toBe(false); // old button / other alert / stranger
    expect(ackReceived(line(`ack:${NONCE}`, "open"), NONCE)).toBe(false);
  });
  it("checkAck polls the ack topic from the given time", async () => {
    const { backend, sent } = setup(() => ({ text: JSON.stringify({ event: "message", message: `ack:${NONCE}` }) + "\n" }));
    expect(await backend.handle("checkAck", { nonce: NONCE, sinceUnix: 1700000000 })).toBe(true);
    expect(sent[0].url).toBe(`https://ntfy.sh/${TOPIC}-ack/json?poll=1&since=1700000000`);
    await expect(backend.handle("checkAck", { nonce: NONCE, sinceUnix: "0&x=1" })).rejects.toThrow();
  });
  it("without a topic: push fails clearly, checkAck is simply false", async () => {
    const { backend, sent } = setup(undefined, { ...CONFIG, ntfyTopic: null });
    await expect(backend.handle("push", { title: "t", message: "m" })).rejects.toThrow("push not configured");
    expect(await backend.handle("checkAck", { nonce: NONCE, sinceUnix: 0 })).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("backend: phone", () => {
  it("places the call to the configured caregiver only, with the script XML-escaped", async () => {
    const { backend, sent } = setup(() => ({ json: { sid: SID } }));
    const placed = await backend.handle("call", { script: 'Help <now> & "fast"', to: "+19005551234" });
    expect(placed).toEqual({ sid: SID, detection: true, trial: false });
    const form = new URLSearchParams(sent[0].body);
    expect(form.get("To")).toBe("+15550002222"); // never the number the page asked for
    expect(form.get("Twiml")).toContain("Help &lt;now&gt; &amp; &quot;fast&quot;");
    expect(form.get("MachineDetection")).toBe("Enable");
  });
  it("falls back to the trial sample call when Twilio restricts the account", async () => {
    let n = 0;
    const { backend, sent } = setup(() => (n++ === 0 ? { status: 400, json: { message: "Trial accounts have limited parameter access" } } : { json: { sid: SID } }));
    expect(await backend.handle("call", { script: "Help" })).toEqual({ sid: SID, detection: false, trial: true });
    expect(new URLSearchParams(sent[1].body).get("Twiml")).toBeNull();
  });
  it("only calls placed by this app can be checked or ended", async () => {
    const { backend, sent } = setup((url) => (url.endsWith("/Calls.json") ? { json: { sid: SID } } : { json: { status: "ringing", answered_by: null } }));
    const other = "CA" + "ffff".repeat(8);
    await expect(backend.handle("callStatus", { sid: other })).rejects.toThrow("unknown call");
    await expect(backend.handle("endCall", { sid: SID })).rejects.toThrow("unknown call"); // not placed yet
    await backend.handle("call", { script: "Help" });
    expect(await backend.handle("callStatus", { sid: SID })).toEqual({ status: "ringing", answeredBy: null });
    await expect(backend.handle("callStatus", { sid: `${SID}/../../Messages` })).rejects.toThrow("unknown call");
    expect(sent.every((s) => !s.url.includes(".."))).toBe(true);
  });
  it("error messages never contain the auth token or Twilio's raw text", async () => {
    const { backend } = setup(() => ({ status: 401, json: { code: 20003, message: `Authenticate ${TOKEN}` } }));
    const err = await backend.handle("sms", { body: "Help" }).catch((e: Error) => e.message);
    expect(err).toBe("Twilio error 401 (code 20003)");
  });
  it("without Twilio settings nothing is sent", async () => {
    const { backend, sent } = setup(undefined, { ...CONFIG, twilio: null });
    await expect(backend.handle("call", { script: "Help" })).rejects.toThrow("phone not configured");
    await expect(backend.handle("sms", { body: "Help" })).rejects.toThrow("phone not configured");
    expect(sent).toHaveLength(0);
  });
});

describe("backend: rate limits", () => {
  it("stops a runaway page from placing call after call, and recovers later", async () => {
    const { backend, sent, tick } = setup(() => ({ json: { sid: SID } }));
    for (let i = 0; i < 10; i++) await backend.handle("call", { script: "Help" });
    await expect(backend.handle("call", { script: "Help" })).rejects.toThrow("too many requests");
    expect(sent).toHaveLength(10);
    await backend.handle("push", { title: "t", message: "m" }); // other channels are unaffected
    tick(10 * 60_000 + 1);
    await backend.handle("call", { script: "Help" });
    expect(sent).toHaveLength(12);
  });
});

describe("backend: shortcuts", () => {
  it("opens catalogue entries only", async () => {
    const { backend, opened, launched } = setup();
    await backend.handle("openMacro", { macroId: "youtube" });
    await backend.handle("openMacro", { macroId: "calculator" });
    expect(opened).toEqual(["https://www.youtube.com/"]);
    expect(launched).toEqual(["calc.exe"]);
    for (const macroId of ["https://evil.example", "cmd.exe", "../calculator", "", 5]) await expect(backend.handle("openMacro", { macroId })).rejects.toThrow("unknown shortcut");
    expect(opened).toHaveLength(1);
    expect(launched).toHaveLength(1);
  });
});
