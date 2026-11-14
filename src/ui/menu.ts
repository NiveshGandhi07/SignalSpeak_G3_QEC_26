// Menu tree + navigation state machine (pure, no DOM — unit tested).
// AI-assisted: written with help from Claude (Anthropic).

export type Action =
  | { kind: "speak"; text: string; goHome?: boolean }
  | { kind: "calibrate" }
  | { kind: "emergency" }
  | { kind: "placeholder"; text: string };

export type Tone = "danger" | "yes" | "no" | "nav" | "pain";

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  tone?: Tone;
  /** open this sub-menu */
  submenu?: string;
  /** or perform this action */
  action?: Action;
}

export interface Menu {
  id: string;
  title: string;
  columns: number;
  items: MenuItem[];
}

export const ROOT = "home";
export const BACK_ID = "back";

const painItems: MenuItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `pain-${i + 1}`,
  label: String(i + 1),
  tone: "pain" as const,
  action: { kind: "speak" as const, text: `My pain is ${i + 1} out of 10`, goHome: true },
}));

export const MENUS: Record<string, Menu> = {
  home: {
    id: "home",
    title: "Home",
    columns: 3,
    items: [
      { id: "care", label: "Caregiver / Assistance", icon: "🙋", submenu: "care" },
      { id: "yes", label: "Yes", icon: "👍", tone: "yes", action: { kind: "speak", text: "Yes" } },
      { id: "no", label: "No", icon: "👎", tone: "no", action: { kind: "speak", text: "No" } },
      { id: "emergency", label: "Emergency", icon: "🚨", tone: "danger", action: { kind: "emergency" } },
      { id: "binds", label: "Binds", icon: "⚙️", tone: "nav", submenu: "binds" },
      { id: "calibrate", label: "Calibrate", icon: "🎯", tone: "nav", action: { kind: "calibrate" } },
    ],
  },
  care: {
    id: "care",
    title: "Caregiver / Assistance",
    columns: 4,
    items: [
      { id: "call", label: "Call caregiver", icon: "📣", action: { kind: "speak", text: "Please come here, I need you", goHome: true } },
      { id: "pain", label: "Pain", icon: "🤕", submenu: "pain" },
      { id: "water", label: "Water", icon: "💧", action: { kind: "speak", text: "I would like some water", goHome: true } },
      { id: "washroom", label: "Washroom", icon: "🚻", action: { kind: "speak", text: "I need to use the washroom", goHome: true } },
      { id: "reposition", label: "Reposition", icon: "🛏️", action: { kind: "speak", text: "Please help me reposition", goHome: true } },
      { id: "temp", label: "Too hot / cold", icon: "🌡️", submenu: "temp" },
    ],
  },
  pain: {
    id: "pain",
    title: "Pain level",
    columns: 4,
    items: painItems,
  },
  temp: {
    id: "temp",
    title: "Temperature",
    columns: 3,
    items: [
      { id: "hot", label: "Too hot", icon: "🥵", action: { kind: "speak", text: "I am too hot", goHome: true } },
      { id: "cold", label: "Too cold", icon: "🥶", action: { kind: "speak", text: "I am too cold", goHome: true } },
    ],
  },
  binds: {
    id: "binds",
    title: "Binds",
    columns: 3,
    items: [
      { id: "bind-scroll", label: "Scroll", icon: "↕️", action: { kind: "placeholder", text: "Scroll binding — coming soon" } },
      { id: "bind-click", label: "Click", icon: "👆", action: { kind: "placeholder", text: "Click binding — coming soon" } },
    ],
  },
};

const BACK: MenuItem = { id: BACK_ID, label: "Back", icon: "⬅️", tone: "nav" };

/** Navigation state: stack of open menu ids, root first. */
export interface NavState {
  stack: string[];
}

export const initialNav = (): NavState => ({ stack: [ROOT] });

export function currentMenu(s: NavState, menus = MENUS): Menu {
  return menus[s.stack[s.stack.length - 1]];
}

/** Items to show for the current menu; every sub-menu gets a Back tile first so it's always in the same place. */
export function visibleItems(s: NavState, menus = MENUS): MenuItem[] {
  const m = currentMenu(s, menus);
  return s.stack.length > 1 ? [BACK, ...m.items] : m.items;
}

export function breadcrumb(s: NavState, menus = MENUS): string {
  return s.stack.map((id) => menus[id].title).join(" › ");
}

/** Pure transition: selecting an item returns the next nav state and an optional side effect. */
export function selectItem(s: NavState, itemId: string, menus = MENUS): { nav: NavState; action: Action | null } {
  if (itemId === BACK_ID) {
    return { nav: { stack: s.stack.length > 1 ? s.stack.slice(0, -1) : s.stack }, action: null };
  }
  const item = visibleItems(s, menus).find((i) => i.id === itemId);
  if (!item) return { nav: s, action: null };
  if (item.submenu) return { nav: { stack: [...s.stack, item.submenu] }, action: null };
  const action = item.action ?? null;
  const goHome = action?.kind === "speak" && action.goHome;
  return { nav: goHome ? initialNav() : s, action };
}
