// Renders the current menu as big gaze-selectable tiles and runs the actions from menu.ts.
// Spoken phrases wait a few seconds first (undo before speaking): look away or look at Cancel to
// cancel, look at "Say it now" to skip the wait, or do nothing and it is spoken when the bar runs out.
// AI-assisted: written with help from Claude (Anthropic).
import { breadcrumb, buildMenus, currentMenu, initialNav, selectItem, visibleItems, type Action, type Menu, type NavState } from "./menu";
import { Alarm } from "./alarm";
import { renderAboutCard } from "./aboutCard";
import { speak } from "../tts/speak";
import { parseEnabled, toggleMacro } from "../macros/catalog";
import { openMacro } from "../macros/open";
import { PROFILE } from "../profile/profile";
import { fractionLeft, isDue, remainingMs, type PendingSpeech } from "./pendingSpeech";

export interface BoardCallbacks {
  onCalibrate: () => void;
  onMessage: (text: string) => void;
  /** current undo window (grows when the user is tired); quick = Yes/No */
  speakDelayMs: (quick: boolean) => number;
  /** user cancelled a phrase — a signal of mistakes / fatigue */
  onUndo: () => void;
}

/** How a tile may be selected. dwellMs null = use the normal method (brow raise or normal dwell). */
export interface SelectRule {
  dwellMs: number | null;
  browAllowed: boolean;
}

const NORMAL: SelectRule = { dwellMs: null, browAllowed: true };
const ALARM_STOP_RULE: SelectRule = { dwellMs: 3000, browAllowed: false }; // deliberately hard to hit by accident
const QUICK_RULE: SelectRule = { dwellMs: 600, browAllowed: true }; // Cancel / Say it now: a quick look is enough
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
  private pending: PendingSpeech | null = null;
  private pendingTimer: number | null = null;
  private pendingEl: HTMLDivElement;
  private pendingText: HTMLDivElement;
  private pendingBar: HTMLDivElement;
  private cancelTile: HTMLDivElement;
  private sendTile: HTMLDivElement;
  /** bumped on every screen change so the selection logic can restart cleanly */
  version = 0;

  constructor(root: HTMLElement, cb: BoardCallbacks) {
    this.cb = cb;
    root.innerHTML = `<div class="crumb"></div><div class="grid"></div>`;
    this.header = root.querySelector(".crumb")!;
    this.grid = root.querySelector(".grid")!;
    this.alarm = new Alarm(document.body);

    this.pendingEl = document.createElement("div");
    this.pendingEl.id = "pending";
    this.pendingEl.hidden = true;
    this.pendingEl.innerHTML = `
      <div class="pendingInfo"><div class="pendingText"></div><div class="pendingTrack"><div class="pendingBar"></div></div></div>
      <div class="tile sendTile"><span class="icon">✓</span><span>Say it now</span></div>
      <div class="tile cancelTile"><span class="icon">✖</span><span>Cancel</span><small>or look away</small></div>`;
    this.pendingText = this.pendingEl.querySelector(".pendingText")!;
    this.pendingBar = this.pendingEl.querySelector(".pendingBar")!;
    this.cancelTile = this.pendingEl.querySelector(".cancelTile")!;
    this.sendTile = this.pendingEl.querySelector(".sendTile")!;
    document.body.appendChild(this.pendingEl);

    this.render();
  }

  /** Elements the gaze cursor can currently select. While a phrase is pending, only the bar's tiles. */
  targets(): HTMLElement[] {
    if (this.alarm.active) return [this.alarm.stopTile];
    if (this.pending) return [this.sendTile, this.cancelTile];
    return this.tiles;
  }

  selectRule(el: HTMLElement): SelectRule {
    if (el === this.alarm.stopTile) return ALARM_STOP_RULE;
    if (el === this.cancelTile || el === this.sendTile) return QUICK_RULE;
    return NORMAL;
  }

  get alarmActive(): boolean {
    return this.alarm.active;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** "Look away to cancel": called when the user looks off-screen or turns away. */
  lookAway(): void {
    this.cancelPending("looked away");
  }

  activate(el: HTMLElement): void {
    if (el === this.alarm.stopTile) {
      this.alarm.stop();
      this.cb.onMessage("Alarm stopped");
      this.version++;
      return;
    }
    if (el === this.cancelTile) {
      this.cancelPending();
      return;
    }
    if (el === this.sendTile) {
      this.sayNow();
      return;
    }
    flash(el);
    const { nav, action } = selectItem(this.nav, el.dataset.id!, this.menus);
    const changed = nav !== this.nav;
    this.nav = nav;
    if (action) this.run(action);
    if (changed) this.render();
  }

  /** Emergency gesture from any screen. */
  triggerEmergency(): void {
    if (this.alarm.active) return;
    this.clearPending();
    this.alarm.start();
    this.version++;
  }

  private run(a: Action): void {
    switch (a.kind) {
      case "speak":
        this.schedule(a.text, !!a.quick);
        break;
      case "emergency":
        this.triggerEmergency();
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

  // ---------- undo before speaking ----------
  private schedule(text: string, quick: boolean): void {
    this.clearPending();
    this.pending = { text, startedAt: performance.now(), delayMs: this.cb.speakDelayMs(quick) };
    this.pendingEl.hidden = false;
    this.version++;
    this.updatePending();
    this.pendingTimer = window.setInterval(() => this.updatePending(), 100);
  }

  private updatePending(): void {
    const p = this.pending;
    if (!p) return;
    const now = performance.now();
    if (isDue(p, now)) return this.sayNow();
    this.pendingText.textContent = `Saying “${p.text}” in ${Math.ceil(remainingMs(p, now) / 1000)} s`;
    this.pendingBar.style.transform = `scaleX(${fractionLeft(p, now)})`;
  }

  private sayNow(): void {
    const p = this.pending;
    if (!p) return;
    this.clearPending();
    speak(p.text);
    this.cb.onMessage(`🔊 “${p.text}”`);
  }

  private cancelPending(reason?: string): void {
    if (!this.pending) return;
    const text = this.pending.text;
    this.clearPending();
    this.cb.onUndo();
    this.cb.onMessage(`✖ Cancelled “${text}”${reason ? ` (${reason})` : ""}`);
  }

  private clearPending(): void {
    if (this.pendingTimer !== null) clearInterval(this.pendingTimer);
    this.pendingTimer = null;
    if (this.pending) this.version++;
    this.pending = null;
    this.pendingEl.hidden = true;
  }

  // ---------- rendering ----------
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
