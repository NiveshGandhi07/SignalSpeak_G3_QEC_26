// Vite config (Vite, MIT — https://vite.dev).
// Development only: `npm run dev` serves the interface in a browser and exposes the trusted backend
// (electron/backend.ts — the same code the desktop app runs in its main process) at POST /api/backend.
// Credentials come from .env.local (git-ignored) and never reach the browser.
//
// The endpoint can phone and text a real person, so it only answers the page this server served:
// loopback Host, same Origin, JSON body (see isLocalRequest in electron/security.ts), small bodies only.
// The installed desktop app has no HTTP server at all.
// AI-assisted: written with help from Claude (Anthropic).
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { createBackend } from "./electron/backend.ts";
import { isLocalRequest, toConfig } from "./electron/security.ts";

const MAX_BODY_BYTES = 4096;

function devBackend(env: Record<string, string>): Plugin {
  const { config, problems } = toConfig(env);
  for (const p of problems) console.warn(`[settings] ${p}`);
  const urlOpener: Record<string, string> = { win32: "explorer.exe", darwin: "open", linux: "xdg-open" };
  const backend = createBackend({
    config,
    openUrl: async (url) => {
      const cmd = urlOpener[process.platform];
      if (!cmd) throw new Error(`not supported on ${process.platform}`);
      spawn(cmd, [url], { detached: true, stdio: "ignore", shell: false }).on("error", () => {}).unref();
    },
  });

  const reply = (res: ServerResponse, status: number, data: object) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(JSON.stringify(data));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > MAX_BODY_BYTES) reject(new Error("request too large"));
      });
      req.on("end", () => resolve(raw));
      req.on("error", reject);
    });

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith("/api/")) return next();
    if (req.method !== "POST" || req.url !== "/api/backend") return reply(res, 404, { error: "not found" });
    const { host, origin } = req.headers;
    if (!isLocalRequest({ host, origin, contentType: req.headers["content-type"] })) return reply(res, 403, { error: "forbidden" });
    try {
      const { method, payload } = JSON.parse(await readBody(req)) as { method?: unknown; payload?: unknown };
      reply(res, 200, { result: (await backend.handle(method, payload)) ?? null });
    } catch (e) {
      reply(res, 400, { error: (e as Error).message });
    }
  };

  return {
    name: "signalspeak-dev-backend",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ""); // "" = also load non-VITE_ (server-only) vars
  // server.host is left at Vite's default (localhost): the dev server never listens on the network
  return { plugins: [devBackend(env)] };
});
