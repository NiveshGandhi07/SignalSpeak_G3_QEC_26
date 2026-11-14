// Renders the current menu as big gaze-selectable tiles and runs the actions from menu.ts.
// AI-assisted: written with help from Claude (Anthropic).
import { breadcrumb, currentMenu, initialNav, selectItem, visibleItems, type Action, type NavState } from "./menu";
import { Alarm } from "./alarm";
import { speak } from "../tts/speak";

export interface BoardCallbacks {
  onCalibrate: () => void;
  onMessage: (text: string) => void;
}

const ALARM_STOP_DWELL_MS = 3000; // deliberately longer than normal dwell

export class Board {
  private nav: NavState = initialNav();
  private header: HTMLDivElement;
  private grid: HTMLDivElement;
  private tiles: HTMLElement[] = [];
  private alarm: Alarm;
  private cb: BoardCallbacks;
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
    const { nav, action } = selectItem(this.nav, el.dataset.id!);
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
      case "placeholder":
        this.cb.onMessage(a.text);
        break;
    }
  }

  private render(): void {
    const menu = currentMenu(this.nav);
    this.header.textContent = breadcrumb(this.nav);
    this.grid.style.gridTemplateColumns = `repeat(${menu.columns}, 1fr)`;
    this.grid.innerHTML = "";
    this.tiles = visibleItems(this.nav).map((item) => {
      const el = document.createElement("div");
      el.className = `tile ${item.tone ?? ""}`;
      el.dataset.id = item.id;
      if (item.tone === "pain") el.style.setProperty("--pain", item.label);
      el.innerHTML = `${item.icon ? `<span class="icon">${item.icon}</span>` : ""}<span>${item.label}</span>`;
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

function flash(el: HTMLElement): void {
  el.classList.add("selected");
  setTimeout(() => el.classList.remove("selected"), 500);
}
