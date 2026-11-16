// Help: a small gaze-selectable button in the bottom-right corner that opens a short "how to use"
// card. The text reflects the user's current settings (select method, emergency gesture).
// AI-assisted: written with help from Claude (Anthropic).
import { icon } from "./icons";
import { EMERGENCY_BINDS, type CalibrateBind, type EmergencyBind } from "../events/emergencyGesture";

export interface HelpContext {
  /** eyebrow raise selects (true) or look-and-hold (false) */
  usesBrow: boolean;
  emergency: EmergencyBind;
  calibrate: CalibrateBind;
  painCheck: boolean;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function helpItems(ctx: HelpContext): { icon: string; title: string; text: string }[] {
  const bind = EMERGENCY_BINDS.find((b) => b.id === ctx.emergency) ?? EMERGENCY_BINDS[0];
  const cal = EMERGENCY_BINDS.find((b) => b.id === ctx.calibrate);
  return [
    { icon: "eye", title: "Point", text: "Look at a tile. It lights up when the cursor is on it." },
    ctx.usesBrow
      ? { icon: "brow", title: "Select", text: "Raise your eyebrows while looking at the tile. The ring fills as they go up." }
      : { icon: "target", title: "Select", text: "Keep looking at the tile until the ring fills." },
    { icon: "x", title: "Undo", text: "After choosing a phrase, look away from the screen before it is spoken to cancel it." },
    { icon: "back", title: "Go back", text: "The Back tile is always top-left on every screen." },
    { icon: "alert", title: "Emergency", text: `From any screen: ${bind.sub.toLowerCase()}. You will hear a chirp after each step.` },
    ...(cal
      ? [{ icon: "target", title: "Recalibrate", text: `If the cursor drifts, from any screen: ${cal.sub.toLowerCase()}.` }]
      : []),
    { icon: "battery", title: "Energy", text: "The meter at the top shows your energy. When it drops, the app slows down and asks for less." },
  ];
}

/**
 * "My controls" for the About me card — so a new caregiver, nurse or visitor can see at a glance how
 * this person uses the screen and which gesture means what.
 */
export function controlLines(ctx: HelpContext): { name: string; detail: string }[] {
  const g = (id: CalibrateBind) => EMERGENCY_BINDS.find((b) => b.id === id);
  const cal = g(ctx.calibrate);
  return [
    { name: "Point", detail: "Eye gaze" },
    { name: "Select", detail: ctx.usesBrow ? "Look, then raise eyebrows" : "Look and hold" },
    { name: "Emergency", detail: g(ctx.emergency)!.sub },
    { name: "Recalibrate", detail: cal ? cal.sub : "Calibrate tile only" },
    { name: "Pain check", detail: ctx.painCheck ? "On — asks if I grimace" : "Off" },
  ];
}

export class Help {
  readonly button: HTMLDivElement;
  readonly closeTile: HTMLDivElement;
  private overlay: HTMLDivElement;
  private list: HTMLDivElement;
  private getCtx: () => HelpContext;
  open = false;

  constructor(parent: HTMLElement, getCtx: () => HelpContext) {
    this.getCtx = getCtx;
    this.button = document.createElement("div");
    this.button.id = "helpBtn";
    this.button.className = "tile nav";
    this.button.innerHTML = `${icon("help")}<span>Help</span>`;

    this.overlay = document.createElement("div");
    this.overlay.id = "help";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="helpCard">
        <div class="helpTitle">How to use SignalSpeak</div>
        <div class="helpList"></div>
      </div>
      <div class="tile helpClose">${icon("back")}<span>Back</span></div>`;
    this.list = this.overlay.querySelector(".helpList")!;
    this.closeTile = this.overlay.querySelector(".helpClose")!;
    parent.append(this.button, this.overlay);
  }

  show(): void {
    this.list.innerHTML = helpItems(this.getCtx())
      .map((i) => `<div class="helpItem">${icon(i.icon)}<div><b>${esc(i.title)}</b><span>${esc(i.text)}</span></div></div>`)
      .join("");
    this.overlay.hidden = false;
    this.button.hidden = true;
    this.open = true;
  }

  hide(): void {
    this.overlay.hidden = true;
    this.button.hidden = false;
    this.open = false;
  }

  setButtonVisible(v: boolean): void {
    this.button.hidden = !v || this.open;
  }
}
