// Opens a macro. Preferred path: ask the local server (vite.config.ts /api/open) to launch it with the
// operating system, which works without a click and can also start desktop apps. Fallback: window.open
// (browsers may block pop-ups that weren't triggered by a click).
// AI-assisted: written with help from Claude (Anthropic).
import { findMacro } from "./catalog";

export async function openMacro(id: string): Promise<string> {
  const m = findMacro(id);
  if (!m) return "Unknown shortcut";
  try {
    const res = await fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ macroId: id }),
    });
    if (res.ok) return `Opening ${m.label}…`;
  } catch {
    /* server not available — fall through */
  }
  if (m.target.kind === "url" && window.open(m.target.url, "_blank")) return `Opening ${m.label}…`;
  return `Couldn't open ${m.label} — start the app with npm run dev`;
}
