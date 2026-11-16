// Tests for the desktop app's security rules. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTags, cleanText, CSP, isAppUrl, isCallSid, isLocalRequest, isNonce, isStrongTopic, parseEnv, RateLimiter, resolveAsset, toConfig } from "../electron/security";
import { parseSavedCalibration } from "../src/gaze/storage";

describe("app origin", () => {
  it("accepts only app://signalspeak", () => {
    expect(isAppUrl("app://signalspeak/index.html")).toBe(true);
    for (const bad of ["https://signalspeak/", "app://evil/index.html", "app://signalspeak.evil.com/", "file:///C:/x.html", "javascript:alert(1)", "", undefined, null])
      expect(isAppUrl(bad)).toBe(false);
  });
});

describe("content security policy", () => {
  it("allows no inline or remote script, and no network beyond the app itself", () => {
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).not.toMatch(/unsafe-inline|'unsafe-eval'|https?:|\*/);
  });
});

describe("serving files", () => {
  const root = path.resolve("/app/dist");
  it("serves files inside the folder with the right type", () => {
    expect(resolveAsset(root, "/")).toEqual({ file: path.join(root, "index.html"), mime: "text/html; charset=utf-8" });
    expect(resolveAsset(root, "/wasm/vision_wasm_internal.wasm")?.mime).toBe("application/wasm");
    expect(resolveAsset(root, "/assets/index-abc.js")?.file).toBe(path.join(root, "assets", "index-abc.js"));
  });
  it("refuses every way of escaping the folder", () => {
    for (const bad of ["/../secrets.bin", "/..%2f..%2fwindows/win.ini", "/%2e%2e/%2e%2e/x.js", "/..\\..\\x.js", "/assets/../../x.js", "//etc/passwd.js", "/C:/Windows/x.js", "/a%00.js", "/%E0%A4%A"]) {
      const r = resolveAsset(root, bad);
      if (r) expect(r.file.startsWith(root + path.sep)).toBe(true); // normalised back inside, never outside
    }
    expect(resolveAsset(root, "/../secrets.bin")).toBeNull();
    expect(resolveAsset(root, "/..\\..\\x.js")).toBeNull();
    expect(resolveAsset(root, "/a%00.js")).toBeNull();
  });
  it("refuses file types the app doesn't ship", () => {
    expect(resolveAsset(root, "/secrets.bin")).toBeNull();
    expect(resolveAsset(root, "/config.env")).toBeNull();
    expect(resolveAsset(root, "/x.exe")).toBeNull();
  });
});

describe("input validation", () => {
  it("cleanText strips control characters, collapses space and caps the length", () => {
    expect(cleanText("  I need\r\nhelp\u0000 now ", 100)).toBe("I need help now");
    expect(cleanText("x".repeat(900), 500)).toHaveLength(500);
  });
  it("cleanText rejects non-text and empty text", () => {
    for (const bad of [undefined, null, 5, {}, ["a"], "", " \n "]) expect(() => cleanText(bad, 10)).toThrow();
  });
  it("call ids and acknowledge codes must have the exact expected shape", () => {
    expect(isCallSid("CA" + "0af1".repeat(8))).toBe(true);
    for (const bad of ["CA123", "CA" + "0af1".repeat(8) + "/../Messages", "ca" + "0af1".repeat(8), 7]) expect(isCallSid(bad)).toBe(false);
    expect(isNonce("3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b")).toBe(true);
    for (const bad of ["ack", "", "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b\nx", null]) expect(isNonce(bad)).toBe(false);
  });
  it("tags are limited to simple short-codes", () => {
    expect(cleanTags(["bell", "Rotating Light", "a,b", 3, "ok_1"])).toEqual(["bell", "ok_1"]);
    expect(cleanTags(undefined)).toEqual([]);
    expect(() => cleanTags("bell")).toThrow();
  });
});

describe("settings", () => {
  const good = {
    NTFY_TOPIC: "signalspeak-k3v9q2m8x7w4z1",
    TWILIO_ACCOUNT_SID: "AC" + "0123456789abcdef".repeat(2),
    TWILIO_AUTH_TOKEN: "fedcba9876543210".repeat(2),
    TWILIO_FROM: "+15550001111",
    CAREGIVER_PHONE: "+15550002222",
  };
  it("parses .env text, ignoring comments, quotes and stray spaces", () => {
    expect(parseEnv('# comment\nNTFY_TOPIC = "abc"\n\nCAREGIVER_PHONE=+1 555 000 2222\r\nlowercase=x')).toEqual({ NTFY_TOPIC: "abc", CAREGIVER_PHONE: "+15550002222" });
  });
  it("accepts complete, well-formed settings", () => {
    const { config, problems } = toConfig(good);
    expect(problems).toEqual([]);
    expect(config.ntfyTopic).toBe(good.NTFY_TOPIC);
    expect(config.twilio).toEqual({ sid: good.TWILIO_ACCOUNT_SID, token: good.TWILIO_AUTH_TOKEN, from: "+15550001111", to: "+15550002222" });
    expect(config.autoStart).toBe(false);
  });
  it("still reads the old VITE_NTFY_TOPIC name", () => {
    expect(toConfig({ VITE_NTFY_TOPIC: good.NTFY_TOPIC }).config.ntfyTopic).toBe(good.NTFY_TOPIC);
  });
  it("refuses guessable topics (anyone could read or send the alerts)", () => {
    for (const weak of ["signalspeak", "signalspeak-change-me", "alerts", "my topic with spaces 12345", "x".repeat(70)]) expect(isStrongTopic(weak)).toBe(false);
    const { config, problems } = toConfig({ NTFY_TOPIC: "signalspeak-change-me" });
    expect(config.ntfyTopic).toBeNull();
    expect(problems).toHaveLength(1);
  });
  it("turns the phone off rather than use malformed credentials — and never echoes them", () => {
    const { config, problems } = toConfig({ ...good, CAREGIVER_PHONE: "555-0002" });
    expect(config.twilio).toBeNull();
    expect(problems.join(" ")).not.toContain(good.TWILIO_AUTH_TOKEN);
  });
  it("no settings at all is fine (everything simply off)", () => {
    expect(toConfig({})).toEqual({ config: { ntfyTopic: null, twilio: null, autoStart: false }, problems: [] });
  });
});

describe("rate limiter", () => {
  it("allows max requests per window, then recovers as time passes", () => {
    const r = new RateLimiter(3, 1000);
    expect([0, 10, 20, 30].map((t) => r.allow("call", t))).toEqual([true, true, true, false]);
    expect(r.allow("call", 900)).toBe(false);
    expect(r.allow("call", 1001)).toBe(true); // the first request left the window
  });
  it("counts each key separately", () => {
    const r = new RateLimiter(1, 1000);
    expect(r.allow("call", 0)).toBe(true);
    expect(r.allow("sms", 0)).toBe(true);
  });
});

describe("dev server request check", () => {
  const ok = { host: "localhost:5173", origin: "http://localhost:5173", contentType: "application/json" };
  it("accepts the page the server itself served", () => {
    expect(isLocalRequest(ok)).toBe(true);
    expect(isLocalRequest({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", contentType: "application/json; charset=utf-8" })).toBe(true);
  });
  it("rejects another website calling the API (CSRF)", () => {
    expect(isLocalRequest({ ...ok, origin: "https://evil.example" })).toBe(false);
    expect(isLocalRequest({ ...ok, origin: "http://localhost:9999" })).toBe(false);
    expect(isLocalRequest({ ...ok, origin: "null" })).toBe(false);
  });
  it("rejects form-style bodies that browsers send cross-site without asking", () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", undefined]) expect(isLocalRequest({ ...ok, contentType })).toBe(false);
  });
  it("rejects DNS rebinding and network hosts", () => {
    for (const host of ["evil.example:5173", "192.168.1.20:5173", "localhost.evil.example", undefined]) expect(isLocalRequest({ ...ok, host, origin: undefined })).toBe(false);
  });
});

describe("saved calibration", () => {
  const good = {
    eye: { cx: 0.5, cy: 0, kx: 2.5, ky: 2.5 },
    reg: { mean: [0, 0, 0, 0, 0, 0], std: [1, 1, 1, 1, 1, 1], wx: [960, 1, 0, 0, 0, 0, 0], wy: [540, 0, 1, 0, 0, 0, 0] },
    errorPx: 42,
    brow: { baseline: 0.1, low: 0.2, high: 0.3 },
    offset: [12, -8],
  };
  it("accepts a valid calibration and keeps only known fields", () => {
    expect(parseSavedCalibration({ ...good, extra: "<img onerror=alert(1)>" })).toEqual(good);
  });
  it("accepts dwell-mode calibration (no brow) and old saves without an offset", () => {
    const { offset: _o, ...old } = good;
    expect(parseSavedCalibration({ ...old, brow: null })).toEqual({ ...good, brow: null, offset: [0, 0] });
  });
  it("rejects anything that would put NaN into the cursor", () => {
    const bad: unknown[] = [
      null,
      "x",
      [],
      {},
      { ...good, eye: { ...good.eye, kx: "2.5" } },
      { ...good, reg: { ...good.reg, wx: [1, 2] } },
      { ...good, reg: { ...good.reg, std: [1, 1, 1, 1, 1, null] } },
      { ...good, errorPx: Infinity },
      { ...good, brow: { baseline: 0.3, low: 0.2, high: 0.1 } },
      { ...good, brow: "yes" },
    ];
    for (const b of bad) expect(parseSavedCalibration(b)).toBeNull();
  });
  it("drops an implausible drift offset instead of trusting it", () => {
    expect(parseSavedCalibration({ ...good, offset: [5000, 0] })?.offset).toEqual([0, 0]);
    expect(parseSavedCalibration({ ...good, offset: [1, NaN] })?.offset).toEqual([0, 0]);
  });
});
