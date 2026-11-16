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
import { icon } from "./icons";
import { applyBind, parseBinds, type Binds, type GestureBindKey } from "../events/emergencyGesture";
import { attempt, listenForAck, newAckNonce, sendPush } from "../emergency/notify";
import { controlLines, Help, type HelpContext } from "./help";

export interface BoardCallbacks {
  onCalibrate: () => void;
  onMessage: (text: string) => void;
  /** current undo window (grows when the user is tired); quick = Yes/No */
  speakDelayMs: (quick: boolean) => number;
  /** user cancelled a phrase — a signal of mistakes / fatigue */
  onUndo: () => void;
  /** the user changed a bind (emergency or recalibrate gesture); changed=false means it was refused */
  onBindsChange: (binds: Binds, key: GestureBindKey | "painCheck", changed: boolean) => void;
  /** current select method, for the Help card */
  usesBrow: () => boolean;
}

/** How a tile may be selected. dwellMs null = use the normal method (brow raise or normal dwell). */
export interface SelectRule {
  dwellMs: number | null;
  browAllowed: boolean;
}

const NORMAL: SelectRule = { dwellMs: null, browAllowed: true };
const ALARM_STOP_RULE: SelectRule = { dwellMs: 3000, browAllowed: false }; // deliberately hard to hit by accident
const CANCEL_RULE: SelectRule = { dwellMs: 600, browAllowed: true }; // Cancel: a quick look is enough
const MACROS_KEY = "signalspeak.macros";
const BINDS_KEY = "signalspeak.binds";
const ASSIST_ACK_WINDOW_MS = 5 * 60_000; // how long we listen for "On my way" after an assistance request

export class Board {
  private nav: NavState = initialNav();
  private header: HTMLDivElement;
  private grid: HTMLDivElement;
  private tiles: HTMLElement[] = [];
  private alarm: Alarm;
  private help: Help;
  private cb: BoardCallbacks;
  private enabledMacros = loadMacros();
  private binds: Binds = loadBinds();
  private menus: Record<string, Menu> = buildMenus(this.enabledMacros, this.binds);
  private pending: PendingSpeech | null = null;
  private pendingTimer: number | null = null;
  private stopAssistAck: () => void = () => {};
  private pendingEl: HTMLDivElement;
  private pendingText: HTMLDivElement;
  private pendingBar: HTMLDivElement;
  private cancelTile: HTMLDivElement;
  /** bumped on every screen change so the selection logic can restart cleanly */
  version = 0;

  constructor(root: HTMLElement, cb: BoardCallbacks) {
    this.cb = cb;
    root.innerHTML = `<div class="crumb"></div><div class="grid"></div>`;
    this.header = root.querySelector(".crumb")!;
    this.grid = root.querySelector(".grid")!;
    this.alarm = new Alarm(document.body);
    this.help = new Help(document.body, () => this.settings());

    this.pendingEl = document.createElement("div");
    this.pendingEl.id = "pending";
    this.pendingEl.hidden = true;
    this.pendingEl.innerHTML = `
      <div class="pendingInfo">
        <div class="pendingLabel">About to say</div>
        <div class="pendingText"></div>
        <div class="pendingTrack"><div class="pendingBar"></div></div>
      </div>
      <div class="tile cancelTile">${icon("x")}<span>Cancel</span><small>or look away</small></div>`;
    this.pendingText = this.pendingEl.querySelector(".pendingText")!;
    this.pendingBar = this.pendingEl.querySelector(".pendingBar")!;
    this.cancelTile = this.pendingEl.querySelector(".cancelTile")!;
    document.body.appendChild(this.pendingEl);

    this.render();
  }

  /** The user's current control settings (Help card + About me card). */
  private settings(): HelpContext {
    return { usesBrow: this.cb.usesBrow(), ...this.binds };
  }

  /**
   * Pain check: show "Are you in pain?" — unless the user is busy (alarm, a phrase about to be spoken,
   * Help open) or already on the pain screens. Returns whether it was shown.
   */
  askAboutPain(): boolean {
    const here = currentMenu(this.nav, this.menus).id;
    if (this.alarm.active || this.pending || this.help.open || here === "pain" || here === "painCheck") return false;
    this.nav = { stack: ["home", "painCheck"] };
    this.render();
    return true;
  }

  /** Elements the gaze cursor can currently select. While a phrase is pending, only Cancel. */
  targets(): HTMLElement[] {
    if (this.alarm.active) return [this.alarm.stopTile];
    if (this.pending) return [this.cancelTile];
    if (this.help.open) return [this.help.closeTile];
    return [...this.tiles.filter((t) => !t.classList.contains("disabled")), this.help.button];
  }

  selectRule(el: HTMLElement): SelectRule {
    if (el === this.alarm.stopTile) return ALARM_STOP_RULE;
    if (el === this.cancelTile) return CANCEL_RULE;
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

  get currentBinds(): Binds {
    return this.binds;
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
    if (el === this.help.button || el === this.help.closeTile) {
      flash(el);
      el === this.help.button ? this.help.show() : this.help.hide();
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

  /** Emergency gesture from any screen. */
  triggerEmergency(): void {
    if (this.alarm.active) return;
    this.clearPending();
    this.help.hide();
    this.stopAssistAck(); // the alarm has its own "on my way" listener
    this.alarm.start();
    this.version++;
  }

  private run(a: Action): void {
    switch (a.kind) {
      case "speak":
        this.schedule(a.text, !!a.quick, a.notify);
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
        this.menus = buildMenus(this.enabledMacros, this.binds);
        this.render();
        break;
      case "home":
        break; // navigation already handled by selectItem
      case "togglePainCheck":
        this.binds = { ...this.binds, painCheck: !this.binds.painCheck };
        saveBinds(this.binds);
        this.menus = buildMenus(this.enabledMacros, this.binds);
        this.render();
        this.cb.onBindsChange(this.binds, "painCheck", true);
        break;
      case "setBind": {
        const next = applyBind(this.binds, a.key, a.value);
        const changed = next !== this.binds;
        this.binds = next;
        saveBinds(this.binds);
        this.menus = buildMenus(this.enabledMacros, this.binds);
        this.render();
        this.cb.onBindsChange(this.binds, a.key, changed);
        break;
      }
    }
  }

  // ---------- undo before speaking ----------
  private schedule(text: string, quick: boolean, notify?: "plain" | "ack"): void {
    this.clearPending();
    this.pending = { text, startedAt: performance.now(), delayMs: this.cb.speakDelayMs(quick), notify };
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
    this.pendingText.textContent = `“${p.text}”  ·  ${Math.ceil(remainingMs(p, now) / 1000)} s`;
    this.pendingBar.style.transform = `scaleX(${fractionLeft(p, now)})`;
  }

  private sayNow(): void {
    const p = this.pending;
    if (!p) return;
    this.clearPending();
    speak(p.text);
    this.cb.onMessage(`Said “${p.text}”`);
    if (p.notify) this.notifyCaregiver(p.text, p.notify === "ack");
  }

  /**
   * Non-emergency request to the caregiver's phone: a normal/high-priority push with the phrase.
   * No phone call and no 911 escalation — those are reserved for the Emergency flow (ui/alarm.ts).
   */
  private notifyCaregiver(text: string, askAck: boolean): void {
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const ackNonce = askAck ? newAckNonce() : undefined;
    attempt(() =>
      sendPush({
        title: askAck ? "Caregiver needed" : "Request",
        message: `${text} (${time})`,
        priority: askAck ? 4 : 3,
        tags: [askAck ? "bell" : "speech_balloon"],
        ackNonce,
      }),
    ).then((r) => this.cb.onMessage(`Said “${text}” · ${r === "Push sent" ? "caregiver notified" : r}`));
    if (!ackNonce || this.alarm.active) return;
    // Tell the user when the caregiver taps "I'm on my way" (they may not be able to see the screen well).
    this.stopAssistAck();
    const unsub = listenForAck(ackNonce, () => {
      stop();
      speak("Your caregiver is on the way");
      this.cb.onMessage("Caregiver is on the way");
    });
    const timer = window.setTimeout(() => stop(), ASSIST_ACK_WINDOW_MS);
    const stop = () => {
      unsub();
      clearTimeout(timer);
      this.stopAssistAck = () => {};
    };
    this.stopAssistAck = stop;
  }

  private cancelPending(reason?: string): void {
    if (!this.pending) return;
    const text = this.pending.text;
    this.clearPending();
    this.cb.onUndo();
    this.cb.onMessage(`Cancelled “${text}”${reason ? ` — ${reason}` : ""}`);
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
    if (menu.view === "about") this.grid.appendChild(renderAboutCard(PROFILE, controlLines(this.settings())));
    this.tiles = visibleItems(this.nav, this.menus).map((item) => {
      const el = document.createElement("div");
      el.className = `tile ${item.tone ?? ""} ${item.checked === undefined ? "" : item.checked ? "on" : "off"} ${item.disabled ? "disabled" : ""}`;
      el.dataset.id = item.id;
      if (item.tone === "pain") el.style.setProperty("--pain", item.label);
      const check = item.checked === undefined ? "" : `<span class="check">${item.checked ? icon("check") : ""}</span>`;
      // labels are escaped: today they are constants, but profiles / custom phrases may not stay that way
      el.innerHTML = `${check}${icon(item.icon)}<span>${esc(item.label)}</span>${item.sub ? `<small>${esc(item.sub)}</small>` : ""}`;
      this.grid.appendChild(el);
      return el;
    });
    this.version++;
  }

  setDimmed(dim: boolean): void {
    this.grid.parentElement!.classList.toggle("dim", dim);
    this.help.setButtonVisible(!dim);
    if (dim) this.help.hide();
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

function loadBinds(): Binds {
  try {
    const raw = localStorage.getItem(BINDS_KEY);
    return parseBinds(raw ? JSON.parse(raw) : undefined);
  } catch {
    return parseBinds(undefined);
  }
}

function saveBinds(b: Binds): void {
  try {
    localStorage.setItem(BINDS_KEY, JSON.stringify(b));
  } catch {
    /* storage unavailable */
  }
}

function saveMacros(ids: string[]): void {
  try {
    localStorage.setItem(MACROS_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable — choice lasts for this session only */
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function flash(el: HTMLElement): void {
  el.classList.add("selected");
  setTimeout(() => el.classList.remove("selected"), 500);
}
