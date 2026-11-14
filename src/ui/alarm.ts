// Emergency alarm: full-screen flashing overlay + repeating beep (Web Audio API) + spoken call for help.
// Escalation (see emergency/escalation.ts):
//   1. push notification (ntfy) + phone call to the caregiver that reads an emergency script
//   2. caregiver answers the call or taps "I'm on my way"  -> "Caregiver is on the way"
//   3. no response -> text message to the caregiver + SIMULATED 911 call pop-up
// Stopping it requires a long dwell on the single "I'm OK" tile so it can't be cancelled by accident.
// AI-assisted: written with help from Claude (Anthropic).
import { speak, stopSpeaking } from "../tts/speak";
import { classifyCall, idle, secondsLeft, step, type Effect, type EscEvent, type EscState } from "../emergency/escalation";
import { attempt, callStatus, endCall, listenForAck, placeCall, sendPush, sendText } from "../emergency/notify";

const CALL_SCRIPT =
  "This is an emergency alert from Signal Speak. Your patient needs help right now. " +
  "Please go to them immediately. If you do not respond, 9 1 1 will be called.";
const CALL_POLL_MS = 2000;

type Channel = "push" | "call" | "text";

export class Alarm {
  readonly overlay: HTMLDivElement;
  readonly stopTile: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private channelsEl: HTMLDivElement;
  private call911El: HTMLDivElement;
  private audio: AudioContext | null = null;
  private beepTimer: number | null = null;
  private tickTimer: number | null = null;
  private pollTimer: number | null = null;
  private unlistenAck: () => void = () => {};
  private esc: EscState = idle();
  private callSid: string | null = null;
  private channels = new Map<Channel, string>();
  /** bumped on every start/stop so late async results from an old alarm are ignored */
  private session = 0;

  constructor(parent: HTMLElement) {
    this.overlay = document.createElement("div");
    this.overlay.id = "alarm";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="alarmText">🚨 EMERGENCY — HELP NEEDED 🚨</div>
      <div class="alarmStatus"></div>
      <div class="alarmChannels"></div>
      <div class="call911" hidden>
        <div class="call911Title">📞 Calling 911…</div>
        <div>The caregiver did not respond.</div>
        <div class="sim">SIMULATION — no real call is placed</div>
      </div>`;
    this.statusEl = this.overlay.querySelector(".alarmStatus")!;
    this.channelsEl = this.overlay.querySelector(".alarmChannels")!;
    this.call911El = this.overlay.querySelector(".call911")!;
    this.stopTile = document.createElement("div");
    this.stopTile.className = "tile alarmStop";
    this.stopTile.innerHTML = `<span class="icon">✋</span><span>I'm OK — stop alarm</span>`;
    this.overlay.appendChild(this.stopTile);
    parent.appendChild(this.overlay);
  }

  get active(): boolean {
    return this.esc.phase !== "idle";
  }

  start(): void {
    if (this.active) return;
    this.session++;
    this.overlay.hidden = false;
    this.call911El.hidden = true;
    this.channels.clear();
    this.renderChannels();
    this.dispatch({ type: "start", now: performance.now() });
    this.unlistenAck = listenForAck(() => this.dispatch({ type: "ack" }));
    const tick = () => {
      this.beep();
      if (this.esc.phase === "waiting") speak("Emergency! I need help now!", 1.05);
    };
    tick();
    this.beepTimer = window.setInterval(tick, 4000);
    this.tickTimer = window.setInterval(() => this.dispatch({ type: "tick", now: performance.now() }), 250);
  }

  stop(): void {
    this.dispatch({ type: "cancel" });
    this.session++;
    this.overlay.hidden = true;
    for (const t of [this.beepTimer, this.tickTimer, this.pollTimer]) if (t !== null) clearInterval(t);
    this.beepTimer = this.tickTimer = this.pollTimer = null;
    this.unlistenAck();
    stopSpeaking();
  }

  private dispatch(e: EscEvent): void {
    const { state, effects } = step(this.esc, e);
    this.esc = state;
    effects.forEach((fx) => this.run(fx));
    this.renderStatus(e.type === "tick" ? e.now : performance.now());
  }

  private run(fx: Effect): void {
    const time = new Date().toLocaleTimeString();
    switch (fx) {
      case "notifyPush":
        this.track("push", attempt(() =>
          sendPush({
            title: "🚨 EMERGENCY",
            message: `Patient needs help NOW (${time}). Tap "I'm on my way" or 911 will be called.`,
            urgent: true,
            askAck: true,
          }),
        ));
        break;
      case "callCaregiver":
        this.startCall();
        break;
      case "sendText":
        this.track("text", attempt(() => sendText(`🚨 EMERGENCY (${time}): patient needs help and you did not respond. 911 is being called.`)));
        void attempt(() => sendPush({ title: "🚑 911 CALLED (simulated)", message: `No caregiver response — escalated at ${time}.`, urgent: true }));
        break;
      case "call911":
        this.stopPolling();
        this.call911El.hidden = false;
        speak("No response. Calling 9 1 1.");
        break;
      case "endCall":
        this.stopPolling();
        if (this.callSid) void endCall(this.callSid);
        this.callSid = null;
        break;
      case "notifyCancelled":
        void attempt(() => sendPush({ title: "✅ Alarm cancelled", message: `Patient indicated they are OK (${time}).` }));
        break;
    }
  }

  /** Place the call, then poll Twilio until we know whether a human answered. */
  private startCall(): void {
    const session = this.session;
    this.channels.set("call", "📞 calling caregiver…");
    this.renderChannels();
    placeCall(CALL_SCRIPT)
      .then(({ sid, detection, trial }) => {
        if (session !== this.session) return void endCall(sid); // alarm already stopped
        this.callSid = sid;
        if (trial) this.channels.set("call", "📞 calling caregiver (Twilio trial message)…");
        this.renderChannels();
        this.pollTimer = window.setInterval(() => this.pollCall(sid, detection, session), CALL_POLL_MS);
      })
      .catch((e: Error) => {
        if (session !== this.session) return;
        this.channels.set("call", `⚠️ ${e.message}`);
        this.renderChannels();
        this.dispatch({ type: "callUnanswered" }); // no call possible -> escalate after the minimum wait
      });
  }

  private async pollCall(sid: string, detection: boolean, session: number): Promise<void> {
    try {
      const { status, answeredBy } = await callStatus(sid);
      if (session !== this.session || this.esc.phase !== "waiting") return;
      const outcome = classifyCall(status, answeredBy, detection);
      if (outcome === "pending") {
        this.channels.set("call", `📞 call ${status}…`);
      } else if (outcome === "answered") {
        this.channels.set("call", "📞 caregiver answered");
        this.stopPolling();
        this.dispatch({ type: "callAnswered" });
      } else {
        this.channels.set("call", `📞 not answered (${answeredBy?.startsWith("machine") ? "voicemail" : status})`);
        this.stopPolling();
        this.dispatch({ type: "callUnanswered" });
      }
      this.renderChannels();
    } catch {
      /* transient network error — keep polling */
    }
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private track(ch: Channel, result: Promise<string>): void {
    const session = this.session;
    this.channels.set(ch, "…");
    this.renderChannels();
    result.then((r) => {
      if (session !== this.session) return;
      this.channels.set(ch, r);
      this.renderChannels();
    });
  }

  private renderChannels(): void {
    this.channelsEl.textContent = [...this.channels.values()].join("   ·   ");
  }

  private renderStatus(now: number): void {
    switch (this.esc.phase) {
      case "waiting":
        this.statusEl.textContent = `Contacting caregiver — calling 911 in ${secondsLeft(this.esc, now)} s if no response`;
        break;
      case "acknowledged":
        this.statusEl.textContent = "✅ Caregiver is on the way";
        break;
      case "escalated":
        this.statusEl.textContent = "🚑 Emergency services contacted (simulated)";
        break;
      default:
        this.statusEl.textContent = "";
    }
  }

  private beep(): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.value = 0.2;
        osc.connect(gain).connect(ctx.destination);
        const t = ctx.currentTime + i * 0.3;
        osc.start(t);
        osc.stop(t + 0.18);
      }
    } catch {
      /* audio blocked — the visual alarm and speech still work */
    }
  }
}
