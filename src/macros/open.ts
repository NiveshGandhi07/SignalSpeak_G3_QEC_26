// Opens a macro by asking the trusted backend (electron/backend.ts), which launches it with the
// operating system — no click needed, and only entries of the macro catalogue can be opened.
// AI-assisted: written with help from Claude (Anthropic).
import { backend } from "../emergency/notify";
import { findMacro } from "./catalog";

export async function openMacro(id: string): Promise<string> {
  const m = findMacro(id);
  if (!m) return "Unknown shortcut";
  try {
    await backend.openMacro(id);
    return `Opening ${m.label}…`;
  } catch {
    return `Couldn't open ${m.label}`;
  }
}
