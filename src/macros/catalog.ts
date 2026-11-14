// Macro catalogue: websites / apps the user can open by gaze, and pure helpers for the user's chosen set.
// The local server (vite.config.ts) only opens entries from this list, so the browser can't ask it to
// run anything arbitrary. Caregivers add new shortcuts by adding entries here.
// AI-assisted: written with help from Claude (Anthropic).

export type MacroTarget = { kind: "url"; url: string } | { kind: "app"; app: "calculator" | "notepad" };

export interface Macro {
  id: string;
  label: string;
  icon: string;
  target: MacroTarget;
}

export const CATALOG: Macro[] = [
  { id: "youtube", label: "YouTube", icon: "▶️", target: { kind: "url", url: "https://www.youtube.com" } },
  { id: "netflix", label: "Netflix", icon: "🎬", target: { kind: "url", url: "https://www.netflix.com" } },
  { id: "spotify", label: "Spotify", icon: "🎵", target: { kind: "url", url: "https://open.spotify.com" } },
  { id: "news", label: "News", icon: "📰", target: { kind: "url", url: "https://news.google.com" } },
  { id: "gmail", label: "Gmail", icon: "✉️", target: { kind: "url", url: "https://mail.google.com" } },
  { id: "weather", label: "Weather", icon: "⛅", target: { kind: "url", url: "https://www.theweathernetwork.com/en/city/ca/ontario/kingston/current" } },
  { id: "calculator", label: "Calculator", icon: "🧮", target: { kind: "app", app: "calculator" } },
  { id: "notepad", label: "Notepad", icon: "📝", target: { kind: "app", app: "notepad" } },
];

export const DEFAULT_MACROS = ["youtube", "spotify", "news", "calculator"];

export function findMacro(id: string): Macro | undefined {
  return CATALOG.find((m) => m.id === id);
}

/** Turn a macro on/off. Result keeps catalogue order and drops unknown ids. */
export function toggleMacro(enabled: string[], id: string): string[] {
  if (!findMacro(id)) return enabled;
  const set = new Set(enabled);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return CATALOG.filter((m) => set.has(m.id)).map((m) => m.id);
}

/** Sanitise a stored list (e.g. from localStorage). */
export function parseEnabled(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_MACROS];
  return CATALOG.filter((m) => raw.includes(m.id)).map((m) => m.id);
}
