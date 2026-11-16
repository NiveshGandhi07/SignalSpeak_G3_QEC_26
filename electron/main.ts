// SignalSpeak desktop app — Electron main process (the trusted side).
// Built with Electron (MIT) https://www.electronjs.org — hardening follows the Electron security
// checklist: https://www.electronjs.org/docs/latest/tutorial/security
//
// What the user gets: one full-screen window that starts hands-free (camera allowed automatically,
// sound allowed without a click), keeps the screen awake, restarts the interface if it crashes and can
// start with Windows.
//
// What an attacker doesn't get:
//  - The interface runs sandboxed, with no Node.js, served from a private app:// origin under a strict
//    Content Security Policy. It has no network access at all, so webcam data cannot leave the machine.
//  - Credentials live only in this process, encrypted on disk (electron/secrets.ts).
//  - The interface can ask for seven validated, rate-limited operations and nothing else.
//  - Only the camera permission is ever granted (never microphone, location, notifications…).
//  - No new windows, no navigation away from the app, no <webview>, no remote content.
// AI-assisted: written with help from Claude (Anthropic).
import { app, BrowserWindow, ipcMain, Menu, powerSaveBlocker, protocol, session, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createBackend } from "./backend.ts";
import { loadConfig } from "./secrets.ts";
import { APP_ORIGIN, CSP, isAppUrl, resolveAsset } from "./security.ts";

const UI_ROOT = path.join(__dirname, "..", "dist"); // the built interface (vite build)
const MAX_RELOADS = 5; // crash-recovery attempts before giving up (avoids a reload loop)

// The app:// scheme behaves like https: secure context (camera), fetch, WebAssembly streaming.
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Speech and alarm sounds must play without a first click — the user can't click.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(start);

async function start(): Promise<void> {
  const { config, problems } = loadConfig();
  for (const p of problems) console.warn(`[settings] ${p}`); // never logs values
  const backend = createBackend({ config, openUrl: (url) => shell.openExternal(url) });

  // ----- serve the interface from app://signalspeak, files inside dist/ only -----
  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    const asset = url.host === "signalspeak" && req.method === "GET" ? resolveAsset(UI_ROOT, url.pathname) : null;
    if (!asset) return new Response("Not found", { status: 404 });
    try {
      const body = await fs.readFile(asset.file);
      return new Response(new Uint8Array(body), {
        headers: {
          "Content-Type": asset.mime,
          "Content-Security-Policy": CSP,
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  // ----- permissions: camera for our own page, nothing else -----
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, allow, details) => {
    const video = "mediaTypes" in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "video";
    allow(permission === "media" && isAppUrl(details.requestingUrl) && !!video);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (permission !== "media" || !isAppUrl(origin)) return false;
    return !("mediaType" in details) || details.mediaType !== "audio";
  });

  // ----- the interface has no network: block every request that isn't our own files -----
  ses.webRequest.onBeforeRequest((details, done) => {
    const scheme = details.url.split(":", 1)[0];
    done({ cancel: !(isAppUrl(details.url) || scheme === "blob" || scheme === "data" || (!app.isPackaged && scheme === "devtools")) });
  });

  // ----- the seven backend operations, from our own page only -----
  ipcMain.handle("signalspeak:backend", (event, method: unknown, payload: unknown) => {
    if (!isAppUrl(event.senderFrame?.url)) throw new Error("forbidden");
    return backend.handle(method, payload);
  });

  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.autoStart });
  powerSaveBlocker.start("prevent-display-sleep"); // a sleeping screen would lock the user out
  Menu.setApplicationMenu(null); // no menu = no reload / dev-tools / zoom keyboard shortcuts

  const win = createWindow();
  app.on("second-instance", () => win.focus());
  app.on("window-all-closed", () => app.quit());
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: "#12151c",
    title: "SignalSpeak",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });

  // Crash recovery: the user can't restart the app by hand.
  let reloads = 0;
  win.webContents.on("render-process-gone", () => {
    if (reloads++ < MAX_RELOADS) win.reload();
  });
  win.on("unresponsive", () => {
    if (reloads++ < MAX_RELOADS) win.webContents.forcefullyCrashRenderer();
  });

  void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

// Applies to every page that could ever exist in this app: stay on app://, open nothing.
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.on("will-redirect", (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.on("will-attach-webview", (e) => e.preventDefault());
});
