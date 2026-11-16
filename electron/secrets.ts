// Where the caregiver's settings (ntfy topic, Twilio credentials, phone numbers) live in the desktop app.
//
// Setup (done once by a caregiver, with a keyboard — the user never needs to):
//   1. Put a file named `config.env` in the app's data folder (same format as .env.example).
//      Windows: %APPDATA%\SignalSpeak\config.env
//   2. Start SignalSpeak. The settings are encrypted with the operating system's credential store
//      (Electron safeStorage — DPAPI on Windows, Keychain on macOS) into `secrets.bin`, and the
//      plain-text file is deleted. Only this Windows user account can decrypt them.
//
// The settings never reach the interface (renderer) — only electron/backend.ts uses them.
// safeStorage docs: https://www.electronjs.org/docs/latest/api/safe-storage
// AI-assisted: written with help from Claude (Anthropic).
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { parseEnv, toConfig, type Config } from "./security.ts";

const PLAIN = "config.env";
const SEALED = "secrets.bin";

export function loadConfig(): { config: Config; problems: string[] } {
  const dir = app.getPath("userData");
  const plainPath = path.join(dir, PLAIN);
  const sealedPath = path.join(dir, SEALED);
  const problems: string[] = [];
  let env: Record<string, string> = {};

  // previously sealed settings
  if (fs.existsSync(sealedPath)) {
    try {
      env = JSON.parse(safeStorage.decryptString(fs.readFileSync(sealedPath))) as Record<string, string>;
    } catch {
      problems.push("Saved settings could not be decrypted (different Windows account?) — add config.env again");
    }
  }

  // a new plain-text file from the caregiver replaces them, is sealed, then removed
  if (fs.existsSync(plainPath)) {
    env = parseEnv(fs.readFileSync(plainPath, "utf8"));
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(sealedPath, safeStorage.encryptString(JSON.stringify(env)), { mode: 0o600 });
      fs.rmSync(plainPath);
    } else {
      problems.push("OS encryption is unavailable — settings stay in plain text in config.env");
    }
  }

  // development only: fall back to the project's .env.local (never read by an installed app)
  if (!app.isPackaged && Object.keys(env).length === 0) {
    const dev = path.join(process.cwd(), ".env.local");
    if (fs.existsSync(dev)) env = parseEnv(fs.readFileSync(dev, "utf8"));
  }

  const r = toConfig(env);
  return { config: r.config, problems: [...problems, ...r.problems] };
}
