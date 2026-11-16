// Menu tree + navigation state machine (pure, no DOM — unit tested).
// AI-assisted: written with help from Claude (Anthropic).
import { CATALOG, DEFAULT_MACROS, findMacro } from "../macros/catalog";
import { introText, PROFILE } from "../profile/profile";
import { DEFAULT_BINDS, EMERGENCY_BINDS, takenBy, type Binds, type CalibrateBind, type EmergencyBind, type GestureBindKey } from "../events/emergencyGesture";

export type Action =
  | {
      kind: "speak";
      text: string;
      goHome?: boolean;
      quick?: boolean;
      /** also send the phrase to the caregiver's phone (ntfy); "ack" adds an "On my way" button */
      notify?: "plain" | "ack";
    }
  | { kind: "calibrate" }
  | { kind: "emergency" }
  | { kind: "openMacro"; macroId: string }
  | { kind: "toggleMacro"; macroId: string }
  | { kind: "setBind"; key: "emergency"; value: EmergencyBind }
  | { kind: "setBind"; key: "calibrate"; value: CalibrateBind }
  | { kind: "togglePainCheck" }
  /** back to the home screen (e.g. "No, I'm OK" on the pain check) */
  | { kind: "home" };

export type Tone = "danger" | "yes" | "no" | "nav" | "pain";

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  /** small second line under the label */
  sub?: string;
  tone?: Tone;
  /** shows a ✓ (e.g. macro is enabled) */
  checked?: boolean;
  /** shown greyed out and can't be selected (e.g. a gesture the other bind already uses) */
  disabled?: boolean;
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
  /** special screen layout; default is a plain tile grid */
  view?: "about";
}

export const ROOT = "home";
export const BACK_ID = "back";

const painItems: MenuItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `pain-${i + 1}`,
  label: String(i + 1),
  tone: "pain" as const,
  action: { kind: "speak" as const, text: `My pain is ${i + 1} out of 10`, goHome: true, notify: "plain" as const },
}));

const STATIC_MENUS: Record<string, Menu> = {
  home: {
    id: "home",
    title: "Home",
    columns: 4,
    items: [
      { id: "care", label: "Caregiver / Assistance", icon: "care", submenu: "care" },
      // quick: short undo window — yes/no are the most frequent answers and need to feel instant
      { id: "yes", label: "Yes", icon: "check", tone: "yes", action: { kind: "speak", text: "Yes", quick: true } },
      { id: "no", label: "No", icon: "x", tone: "no", action: { kind: "speak", text: "No", quick: true } },
      { id: "emergency", label: "Emergency", icon: "alert", tone: "danger", action: { kind: "emergency" } },
      { id: "about", label: "About me", icon: "idcard", submenu: "about" },
      { id: "macros", label: "Macros & Shortcuts", icon: "zap", submenu: "macros" },
      { id: "binds", label: "Binds", icon: "sliders", tone: "nav", submenu: "binds" },
      { id: "calibrate", label: "Calibrate", icon: "target", tone: "nav", action: { kind: "calibrate" } },
    ],
  },
  care: {
    id: "care",
    title: "Caregiver / Assistance",
    columns: 4,
    items: [
      { id: "call", label: "Call caregiver", icon: "bell", action: { kind: "speak", text: "Please come here, I need you", goHome: true, notify: "ack" } },
      { id: "pain", label: "Pain", icon: "pulse", submenu: "pain" },
      { id: "water", label: "Water", icon: "droplet", action: { kind: "speak", text: "I would like some water", goHome: true, notify: "plain" } },
      { id: "washroom", label: "Washroom", icon: "door", action: { kind: "speak", text: "I need to use the washroom", goHome: true, notify: "plain" } },
      { id: "reposition", label: "Reposition", icon: "bed", action: { kind: "speak", text: "Please help me reposition", goHome: true, notify: "plain" } },
      { id: "temp", label: "Too hot / cold", icon: "thermometer", submenu: "temp" },
    ],
  },
  pain: { id: "pain", title: "Pain level", columns: 4, items: painItems },
  temp: {
    id: "temp",
    title: "Temperature",
    columns: 3,
    items: [
      { id: "hot", label: "Too hot", icon: "sun", action: { kind: "speak", text: "I am too hot", goHome: true, notify: "plain" } },
      { id: "cold", label: "Too cold", icon: "snowflake", action: { kind: "speak", text: "I am too cold", goHome: true, notify: "plain" } },
    ],
  },
  // Shown automatically when a sustained grimace is seen (events/grimace.ts). Yes leads to the pain
  // scale, which tells the caregiver how bad it is; No goes home.
  painCheck: {
    id: "painCheck",
    title: "Are you in pain?",
    columns: 3,
    items: [
      { id: "painCheck-yes", label: "Yes, I'm in pain", sub: "Choose how bad", icon: "pulse", tone: "danger", submenu: "pain" },
      { id: "painCheck-no", label: "No, I'm OK", icon: "check", tone: "yes", action: { kind: "home" } },
    ],
  },
  about: {
    id: "about",
    title: "About me",
    columns: 3,
    view: "about",
    items: [{ id: "about-read", label: "Read aloud", icon: "volume", action: { kind: "speak", text: introText(PROFILE) } }],
  },
};

const gestureLabel = (id: CalibrateBind) => (id === "off" ? "Off" : EMERGENCY_BINDS.find((b) => b.id === id)!.label);

/** "Binds": which gesture does what from any screen, plus the automatic pain check. */
export function bindsMenu(binds: Binds): Menu {
  return {
    id: "binds",
    title: "Binds",
    columns: 3,
    items: [
      { id: "binds-emergency", label: "Emergency gesture", sub: gestureLabel(binds.emergency), icon: "alert", tone: "danger", submenu: "bindsEmergency" },
      { id: "binds-calibrate", label: "Recalibrate gesture", sub: gestureLabel(binds.calibrate), icon: "target", tone: "nav", submenu: "bindsCalibrate" },
      {
        id: "binds-painCheck",
        label: "Pain check",
        sub: binds.painCheck ? "Asks if I look in pain" : "Off",
        icon: "pulse",
        checked: binds.painCheck,
        action: { kind: "togglePainCheck" },
      },
    ],
  };
}

/** Gesture tiles for one bind (radio-style). The gesture the other bind uses is shown but can't be picked. */
function gestureItems(binds: Binds, key: GestureBindKey, prefix: string): MenuItem[] {
  const taken = takenBy(binds, key);
  const other = key === "emergency" ? "Recalibrate" : "Emergency";
  return EMERGENCY_BINDS.map((b) => ({
    id: `${prefix}-${b.id}`,
    label: b.label,
    sub: b.id === taken ? `In use for ${other}` : b.sub,
    icon: key === "emergency" ? "alert" : "target",
    checked: binds[key] === b.id,
    disabled: b.id === taken,
    action: { kind: "setBind" as const, key, value: b.id } as Action,
  }));
}

export function emergencyBindMenu(binds: Binds): Menu {
  return { id: "bindsEmergency", title: "Emergency gesture", columns: 4, items: gestureItems(binds, "emergency", "bind") };
}

/** Recalibrate gesture: one of the gestures Emergency isn't using, or Off. */
export function calibrateBindMenu(binds: Binds): Menu {
  return {
    id: "bindsCalibrate",
    title: "Recalibrate gesture",
    columns: 4,
    items: [
      ...gestureItems(binds, "calibrate", "calbind"),
      { id: "calbind-off", label: "Off", sub: "Use the Calibrate tile only", icon: "x", checked: binds.calibrate === "off", action: { kind: "setBind", key: "calibrate", value: "off" } },
    ],
  };
}

/** "Macros & Shortcuts": the user's chosen shortcuts + an Edit tile. */
export function macrosMenu(enabled: string[]): Menu {
  const items: MenuItem[] = enabled.flatMap((id) => {
    const m = findMacro(id);
    return m ? [{ id: `macro-${m.id}`, label: m.label, icon: m.icon, action: { kind: "openMacro" as const, macroId: m.id } }] : [];
  });
  items.push({ id: "macro-edit", label: "Edit macros", icon: "pencil", tone: "nav", submenu: "macroEdit" });
  return { id: "macros", title: "Macros & Shortcuts", columns: items.length + 1 > 6 ? 4 : 3, items };
}

/** Pick which shortcuts appear — by gaze, no keyboard needed. */
export function macroEditMenu(enabled: string[]): Menu {
  return {
    id: "macroEdit",
    title: "Edit macros",
    columns: 3,
    items: CATALOG.map((m) => ({
      id: `toggle-${m.id}`,
      label: m.label,
      icon: m.icon,
      checked: enabled.includes(m.id),
      action: { kind: "toggleMacro" as const, macroId: m.id },
    })),
  };
}

export function buildMenus(enabledMacros: string[], binds: Binds = DEFAULT_BINDS): Record<string, Menu> {
  return {
    ...STATIC_MENUS,
    macros: macrosMenu(enabledMacros),
    macroEdit: macroEditMenu(enabledMacros),
    binds: bindsMenu(binds),
    bindsEmergency: emergencyBindMenu(binds),
    bindsCalibrate: calibrateBindMenu(binds),
  };
}

export const MENUS: Record<string, Menu> = buildMenus(DEFAULT_MACROS, DEFAULT_BINDS);

const BACK: MenuItem = { id: BACK_ID, label: "Back", icon: "back", tone: "nav" };

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
  if (!item || item.disabled) return { nav: s, action: null };
  if (item.submenu) return { nav: { stack: [...s.stack, item.submenu] }, action: null };
  const action = item.action ?? null;
  const goHome = (action?.kind === "speak" && action.goHome) || action?.kind === "home";
  return { nav: goHome ? initialNav() : s, action };
}
