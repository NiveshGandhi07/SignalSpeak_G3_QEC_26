// Renders the current menu as big gaze-selectable tiles and runs the actions from menu.ts.
// AI-assisted: written with help from Claude (Anthropic).
import { breadcrumb, buildMenus, currentMenu, initialNav, selectItem, visibleItems, type Action, type Menu, type NavState } from "./menu";
import { Alarm } from "./alarm";
import { renderAboutCard } from "./aboutCard";
import { speak } from "../tts/speak";
import { parseEnabled, toggleMacro } from "../macros/catalog";
import { openMacro } from "../macros/open";
import { PROFILE } from "../profile/profile";

export interface BoardCallbacks {
  onCalibrate: () => void;
  onMessage: (text: string) => void;
}

const ALARM_STOP_DWELL_MS = 3000; // deliberately longer than normal dwell
const MACROS_KEY = "signalspeak.macros";

export class Board {
  private nav: NavState = initialNav();
  private header: HTMLDivElement;
  private grid: HTMLDivElement;
  private tiles: HTMLElement[] = [];
  private alarm: Alarm;
  private cb: BoardCallbacks;
  private enabledMacros = loadMacros();
  private menus: Record<string, Menu> = buildMenus(this.enabledMacros);
  /** bumped on every screen change so the dwell logic can restart cleanly */
  version = 0;

  constructor(root: HTMLElement, cb: BoardCallbacks) {
    this.cb = cb;
    root.innerHTML = `<div class="crumb"></div><div class="grid"></div>`;
    this.header = root.querySelector(".crumb")!;
    this.grid = root.querySelector(".grid")!;
    this.alarm = new Alarm(document.body);
    this.render();
  }

  /** Elements the gaze cursor can currently select. */
  targets(): HTMLElement[] {
    return this.alarm.active ? [this.alarm.stopTile] : this.tiles;
  }

  dwellMsFor(el: HTMLElement, normal: number): number {
    return el === this.alarm.stopTile ? ALARM_STOP_DWELL_MS : normal;
  }

  activate(el: HTMLElement): void {
    if (el === this.alarm.stopTile) {
      this.alarm.stop();
      this.cb.onMessage("Alarm stopped");
      this.version++;
      return;
    }
    flash(el);
    const { nav, action } = selectItem(this.nav, el.dataset.id!, this.menus);
    const changed = nav !== this.nav;
    this.nav = nav;
    if (action) this.run(action);
    if (changed) this.render();
  }

  private run(a: Action): void {
    switch (a.kind) {
      case "speak":
        speak(a.text);
        this.cb.onMessage(`🔊 “${a.text}”`);
        break;
      case "emergency":
        this.alarm.start();
        this.version++;
        break;
      case "calibrate":
        this.cb.onCalibrate();
        break;
      case "openMacro":
        openMacro(a.macroId).then(this.cb.onMessage);
        break;
      case "toggleMacro":
        this.enabledMacros = toggleMacro(this.enabledMacros, a.macroId);
        saveMacros(this.enabledMacros);
        this.menus = buildMenus(this.enabledMacros);
        this.render();
        break;
      case "placeholder":
        this.cb.onMessage(a.text);
        break;
    }
  }

  private render(): void {
    const menu = currentMenu(this.nav, this.menus);
    this.header.textContent = breadcrumb(this.nav, this.menus);
    this.grid.style.gridTemplateColumns = `repeat(${menu.columns}, 1fr)`;
    this.grid.className = `grid ${menu.view ?? ""}`;
    this.grid.innerHTML = "";
    if (menu.view === "about") this.grid.appendChild(renderAboutCard(PROFILE));
    this.tiles = visibleItems(this.nav, this.menus).map((item) => {
      const el = document.createElement("div");
      el.className = `tile ${item.tone ?? ""} ${item.checked === false ? "off" : ""}`;
      el.dataset.id = item.id;
      if (item.tone === "pain") el.style.setProperty("--pain", item.label);
      const check = item.checked === undefined ? "" : `<span class="check">${item.checked ? "✓" : ""}</span>`;
      el.innerHTML = `${check}${item.icon ? `<span class="icon">${item.icon}</span>` : ""}<span>${item.label}</span>`;
      this.grid.appendChild(el);
      return el;
    });
    this.version++;
  }

  setDimmed(dim: boolean): void {
    this.grid.parentElement!.classList.toggle("dim", dim);
  }

  goHome(): void {
    this.nav = initialNav();
    this.render();
  }
}

function loadMacros(): string[] {
  try {
    const raw = localStorage.getItem(MACROS_KEY);
    return parseEnabled(raw ? JSON.parse(raw) : undefined);
  } catch {
    return parseEnabled(undefined);
  }
}

function saveMacros(ids: string[]): void {
  try {
    localStorage.setItem(MACROS_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable — choice lasts for this session only */
  }
}

function flash(el: HTMLElement): void {
  el.classList.add("selected");
  setTimeout(() => el.classList.remove("selected"), 500);
}
