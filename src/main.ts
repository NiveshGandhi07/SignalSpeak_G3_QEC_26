// SignalSpeak — gaze cursor prototype.
// Flow (fully hands-free): camera starts -> face held in view ~1.5 s -> calibration
//   phase 1: look at 9 dots in turn
//   phase 2: keep looking at the centre dot while gently moving the head (learns head compensation)
//   phase 3: raise the eyebrows (learns this user's brow-raise range)
// -> head-pose-compensated gaze model -> stabilised on-screen cursor.
// Select: look at a tile, then raise the eyebrows. If the brow raise is too weak to detect reliably,
// the app falls back to dwell (look at a tile and hold) — the interface adapts to the user.
// Emergency from any screen: a gesture the user picks under Binds (default: two long blinks within 5 s).
// Fatigue-aware pacing: timings, brow sensitivity and selection method adapt as the user tires.
// AI-assisted: written with help from Claude (Anthropic).
import "./style.css";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createLandmarker, startCamera } from "./vision/landmarker";
import { FaceOverlay } from "./vision/overlay";
import { blinkScore, headPose, rawGaze } from "./gaze/features";
import { fitCalibration, predictScreen, type CalSample, type Calibration } from "./gaze/calibration";
import { Stabilizer } from "./gaze/stabilizer";
import { Board } from "./ui/board";
import { browScore, calibrateBrow, initialBrow, scaleBrow, stepBrow, type BrowParams } from "./events/brow";
import { createEmergencyDetector, EMERGENCY_BINDS, type EmergencyDetector } from "./events/emergencyGesture";
import { FatigueTracker, type Pacing } from "./adapt/fatigue";
import { chirp } from "./ui/sound";
import { isLookingAway } from "./ui/pendingSpeech";

// ---------- tunables ----------
const FACE_HOLD_MS = 1500; // face must be visible this long before calibration auto-starts
const CAL_POINT_MS = 2000; // time per calibration dot
const CAL_SETTLE_MS = 700; // ignore samples while the eyes travel to the dot
const HEAD_PHASE_MS = 5000; // "keep looking at the dot, move your head gently"
const BROW_PHASE_MS = 3500; // "raise your eyebrows and hold"
const BROW_SETTLE_MS = 600; // reaction time before recording the raise
const HOVER_SETTLE_MS = 250; // cursor must rest on a tile this long before a brow raise selects it
const BLINK_REJECT = 0.45; // drop frames where eyes are mostly closed
// Dwell time, re-arm pause and undo window come from the fatigue tracker (adapt/fatigue.ts).
const TILE_STICKY_PX = 60; // once on a tile, stay on it until the cursor is this far outside it
const LOOK_AWAY_MS = 400; // looking off-screen this long cancels a pending phrase
const STORAGE_KEY = "signalspeak.gazeCalibration.v3";

// ---------- DOM ----------
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div id="camWrap"><video id="cam" playsinline muted></video><canvas id="mesh"></canvas></div>
  <div id="status">Loading face model…</div>
  <div id="fatigue" title="Energy"><span class="fLabel">Energy</span><div class="fTrack"><div class="fBar"></div></div><span class="fText"></span></div>
  <div id="board"></div>
  <div id="calDot" hidden></div>
  <div id="cursor" hidden><svg viewBox="0 0 40 40"><circle class="track" cx="20" cy="20" r="17"/><circle class="ring" cx="20" cy="20" r="17"/><circle class="dot" cx="20" cy="20" r="3"/></svg></div>
  <pre id="debug"></pre>
`;
const video = document.querySelector<HTMLVideoElement>("#cam")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const calDot = document.querySelector<HTMLDivElement>("#calDot")!;
const cursor = document.querySelector<HTMLDivElement>("#cursor")!;
const ring = cursor.querySelector<SVGCircleElement>(".ring")!;
const debugEl = document.querySelector<HTMLPreElement>("#debug")!;
const overlay = new FaceOverlay(document.querySelector<HTMLCanvasElement>("#mesh")!, video);
const RING_LEN = 2 * Math.PI * 17;

const fatigueBar = document.querySelector<HTMLDivElement>("#fatigue .fBar")!;
const fatigueText = document.querySelector<HTMLSpanElement>("#fatigue .fText")!;

const fatigue = new FatigueTracker();
const board = new Board(document.querySelector<HTMLDivElement>("#board")!, {
  onCalibrate: () => startCalibration(performance.now()),
  onMessage: (text) => (statusEl.textContent = text),
  speakDelayMs: (quick) => (quick ? fatigue.pacing().quickSpeakDelayMs : fatigue.pacing().speakDelayMs),
  onUndo: () => fatigue.recordUndo(performance.now()),
  usesBrow: () => !!cal?.brow && !fatigue.pacing().preferDwell,
  onBindsChange: () => {
    rebuildEmergencyDetector();
    const b = EMERGENCY_BINDS.find((x) => x.id === emergency.bind)!;
    statusEl.textContent =
      emergency.bind === board.currentBinds.emergency
        ? `Emergency gesture: ${b.label} — ${b.sub}`
        : `That gesture needs a calibrated eyebrow raise — using "${b.label}" instead`;
  },
});

// ---------- state ----------
type Mode =
  | { kind: "waitFace"; since: number | null }
  | { kind: "calibrate"; idx: number; start: number; samples: CalSample[]; browRest: number[]; browRaised: number[] }
  | { kind: "track" };

/** Gaze model + this user's brow thresholds (null = brow raise not usable -> dwell mode). */
type SavedCalibration = Calibration & { brow: BrowParams | null };

let mode: Mode = { kind: "waitFace", since: null };
let cal: SavedCalibration | null = loadCalibration();
if (cal) mode = { kind: "track" };

const stab = new Stabilizer();
let hoverTile: HTMLElement | null = null;
let hoverSince = 0;
let rearmUntil = 0;
let boardVersion = -1;
let brow = initialBrow();
let emergency: EmergencyDetector = createEmergencyDetector(board.currentBinds.emergency, cal?.brow ?? null);
function rebuildEmergencyDetector(): void {
  emergency = createEmergencyDetector(board.currentBinds.emergency, cal?.brow ?? null);
}
// current eyebrow raise, for measuring how high raises go (fatigue)
let raisePeak = 0, raising = false, raiseClicked = false;
let awaySince: number | null = null;
let lastVideoTime = -1;
let frames = 0, fps = 0, fpsT = performance.now();

/** 9 grid dots, then the centre dot for the head-movement phase, then the centre dot for the brow phase. */
function calPoints(): [number, number][] {
  const w = window.innerWidth, h = window.innerHeight;
  const xs = [0.08, 0.5, 0.92], ys = [0.1, 0.5, 0.9];
  const grid = ys.flatMap((y) => xs.map((x) => [x * w, y * h] as [number, number]));
  return [...grid, [0.5 * w, 0.5 * h], [0.5 * w, 0.5 * h]];
}
const HEAD_IDX = 9;
const BROW_IDX = 10;

function loadCalibration(): SavedCalibration | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedCalibration) : null;
  } catch {
    return null;
  }
}
function saveCalibration(c: SavedCalibration): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable — calibration just won't persist */
  }
}

function startCalibration(now: number): void {
  mode = { kind: "calibrate", idx: 0, start: now, samples: [], browRest: [], browRaised: [] };
  cursor.hidden = true;
  board.setDimmed(true);
  document.body.classList.add("calibrating");
}

// ---------- per-frame ----------
function onFrame(lm: FaceLandmarker, now: number): void {
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const res = lm.detectForVideo(video, now);
  const face = res.faceLandmarks[0];
  const shapes = res.faceBlendshapes[0]?.categories ?? [];
  const matrix = res.facialTransformationMatrixes?.[0]?.data ?? null;
  overlay.render(face);

  frames++;
  if (now - fpsT > 1000) {
    fps = frames;
    frames = 0;
    fpsT = now;
  }

  if (!face) {
    cursor.hidden = true;
    if (mode.kind === "track") updateLookAway(true, now); // turned away from the screen
    if (mode.kind === "waitFace") mode.since = null;
    statusEl.textContent = "No face detected — move into view";
    return;
  }
  const g = rawGaze(face, shapes, matrix);
  const blink = blinkScore(shapes);
  const browVal = browScore(shapes);
  const pose = matrix ? headPose(matrix) : { yaw: 0, pitch: 0 };
  const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);
  debugEl.textContent =
    `fps ${fps}  blink ${blink.toFixed(2)}  brow ${browVal.toFixed(2)}` +
    (cal?.brow ? ` (click > ${cal.brow.high.toFixed(2)})` : " (dwell mode)") +
    `  fatigue ${fatigue.score().toFixed(2)} ${JSON.stringify(fatigue.components(), (_k, v) => (typeof v === "number" ? +v.toFixed(2) : v))}\n` +
    `gx ${g.gx.toFixed(3)} gy ${g.gy.toFixed(3)} lookV ${g.lookV.toFixed(2)}\n` +
    `head yaw ${deg(pose.yaw)}° pitch ${deg(pose.pitch)}°  pos ${g.t.map((v) => v.toFixed(0)).join(",")} cm\n` +
    (cal ? `cal error ${cal.errorPx.toFixed(0)} px  k=(${cal.eye.kx}, ${cal.eye.ky})` : "");

  switch (mode.kind) {
    case "waitFace": {
      mode.since ??= now;
      const left = Math.ceil((FACE_HOLD_MS - (now - mode.since)) / 1000);
      document.body.classList.add("calibrating");
      statusEl.textContent = `Face found — sit comfortably. Calibration starts in ${Math.max(left, 0)}`;
      if (now - mode.since >= FACE_HOLD_MS) startCalibration(now);
      break;
    }
    case "calibrate":
      stepCalibration(mode, g, blink, browVal, now);
      break;
    case "track":
      stepTracking(g, blink, browVal, now);
      break;
  }
}

function stepCalibration(
  m: Extract<Mode, { kind: "calibrate" }>,
  g: ReturnType<typeof rawGaze>,
  blink: number,
  browVal: number,
  now: number,
): void {
  const pts = calPoints();
  const headPhase = m.idx === HEAD_IDX;
  const browPhase = m.idx === BROW_IDX;
  const dur = browPhase ? BROW_PHASE_MS : headPhase ? HEAD_PHASE_MS : CAL_POINT_MS;
  const t = now - m.start;
  const [px, py] = pts[m.idx];

  statusEl.textContent = browPhase
    ? "Now raise your eyebrows and hold them up"
    : headPhase
      ? "Keep your eyes on the dot and gently move your head — left, right, up, down"
      : `Look at the dot  ·  ${m.idx + 1} of ${HEAD_IDX}`;
  calDot.hidden = false;
  calDot.classList.toggle("pulse", headPhase || browPhase);
  calDot.classList.toggle("brow", browPhase);
  const scale = headPhase || browPhase ? 1 : 1 - 0.6 * Math.min(t / dur, 1);
  calDot.style.transform = `translate(${px}px, ${py}px) scale(${scale})`;

  if (browPhase) {
    // raised brows distort the eye landmarks, so these frames are only used for the brow threshold
    if (t > BROW_SETTLE_MS) m.browRaised.push(browVal);
  } else if (t > CAL_SETTLE_MS && blink < BLINK_REJECT) {
    m.samples.push({ raw: g, target: [px, py] });
    if (!headPhase) m.browRest.push(browVal);
  }

  if (t >= dur) {
    m.idx++;
    m.start = now;
    if (m.idx >= pts.length) finishCalibration(m);
  }
}

function finishCalibration(m: Extract<Mode, { kind: "calibrate" }>): void {
  calDot.hidden = true;
  calDot.classList.remove("brow");
  document.body.classList.remove("calibrating");
  board.setDimmed(false);
  board.goHome();
  try {
    cal = { ...fitCalibration(m.samples), brow: calibrateBrow(m.browRest, m.browRaised) };
    saveCalibration(cal);
    stab.reset();
    brow = initialBrow();
    rebuildEmergencyDetector();
    mode = { kind: "track" };
    statusEl.textContent =
      `Calibrated (avg error ${cal.errorPx.toFixed(0)} px). ` +
      (cal.brow
        ? "Look at a tile, then raise your eyebrows to select."
        : "Eyebrow raise was too small to detect — look at a tile and hold to select.");
  } catch (err) {
    statusEl.textContent = `Calibration failed: ${(err as Error).message}. Retrying…`;
    mode = { kind: "waitFace", since: null };
  }
}

let cursorX = 0, cursorY = 0;

function stepTracking(g: ReturnType<typeof rawGaze>, blink: number, browVal: number, now: number): void {
  if (!cal) return;
  const pace = fatigue.pacing();

  // Emergency from any screen (gesture chosen under Binds). A chirp marks each step, since the
  // user's eyes are closed while performing it.
  const em = emergency.step(blink, browVal, now);
  if (!board.alarmActive && em.event === "progress") {
    chirp([660, 880]);
    statusEl.textContent = `Emergency gesture ${em.count} of ${emergency.needed} — keep going`;
  } else if (!board.alarmActive && em.event === "trigger") {
    chirp([880, 880, 880]);
    board.triggerEmergency();
  }

  // Eyebrow-raise click. Thresholds relax as the user tires (smaller raise needed).
  const useBrow = !!cal.brow && !pace.preferDwell;
  let click = false, browLevel = 0, browsUp = false;
  if (cal.brow) {
    const p = scaleBrow(cal.brow, pace.browThresholdScale);
    const r = stepBrow(brow, browVal, now, p);
    brow = r.state;
    // no brow "clicks" while the eyes are closed: the user may be performing the emergency gesture
    click = r.click && useBrow && blink <= BLINK_REJECT;
    browLevel = r.level;
    browsUp = browVal > p.low;
    trackRaise(cal.brow, browVal, browsUp, r.click, now);
  }

  // Freeze the cursor during blinks and brow raises: both move the eyelids and would make it jump
  // off the tile the user is trying to select.
  if (blink <= BLINK_REJECT && !(useBrow && browsUp)) {
    const [rx, ry] = predictScreen(cal, g);
    const [sx, sy] = stab.push(rx, ry, now);
    cursorX = clamp(sx, 0, window.innerWidth);
    cursorY = clamp(sy, 0, window.innerHeight);
    updateLookAway(isLookingAway(rx, ry, window.innerWidth, window.innerHeight), now);
  }
  cursor.hidden = false;
  cursor.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
  updateSelection(cursorX, cursorY, now, click, browLevel, useBrow, pace);
  renderFatigue(pace);
}

/** "Look away to cancel": gaze clearly off-screen (or face lost) for LOOK_AWAY_MS cancels a pending phrase. */
function updateLookAway(away: boolean, now: number): void {
  if (!away || !board.hasPending) {
    awaySince = null;
    return;
  }
  awaySince ??= now;
  if (now - awaySince >= LOOK_AWAY_MS) {
    awaySince = null;
    board.lookAway();
  }
}

/** Measure each deliberate eyebrow raise's peak relative to the calibrated raise (fatigue signal). */
function trackRaise(p: BrowParams, value: number, up: boolean, clicked: boolean, now: number): void {
  if (up) {
    raisePeak = raising ? Math.max(raisePeak, value) : value;
    raising = true;
    raiseClicked ||= clicked;
    return;
  }
  if (raising && raiseClicked) {
    const calibratedRange = (p.high - p.baseline) / 0.5; // high was set at 50% of the calibrated raise
    fatigue.recordBrowAmplitude((raisePeak - p.baseline) / calibratedRange, now);
  }
  raising = raiseClicked = false;
}

function renderFatigue(pace: Pacing): void {
  const energy = 1 - pace.score;
  fatigueBar.style.transform = `scaleX(${Math.max(0.04, energy)})`;
  fatigueBar.style.background = pace.level === "fresh" ? "#3fb950" : pace.level === "tired" ? "#e3b341" : "#f85149";
  fatigueText.textContent =
    pace.level === "fresh" ? "Feeling good" : pace.preferDwell ? "Resting brows — look & hold to select" : pace.level === "tired" ? "Tired — pace slowed" : "Very tired — pace slowed";
}

function inRect(el: HTMLElement, x: number, y: number, margin: number): boolean {
  const r = el.getBoundingClientRect();
  return x >= r.left - margin && x <= r.right + margin && y >= r.top - margin && y <= r.bottom + margin;
}

/**
 * Decide what's selected. Two modes:
 *  - brow mode (default when calibration found a usable brow raise): look at a tile, raise brows.
 *    The ring shows how far the brows are raised.
 *  - dwell mode (fallback, or when fatigue shows brow raises failing): look at a tile and hold.
 * Some tiles have their own rule (board.selectRule): the alarm's "I'm OK" needs a long dwell so it
 * can't be cancelled by accident; "Cancel" accepts a quick look so mistakes are easy to undo.
 */
function updateSelection(x: number, y: number, now: number, click: boolean, browLevel: number, useBrow: boolean, pace: Pacing): void {
  // Screen changed (new menu / alarm / cancel bar): forget the old tile and pause briefly, so the tile
  // that appears under the user's gaze isn't selected immediately ("rearm" delay).
  if (board.version !== boardVersion) {
    boardVersion = board.version;
    hoverTile?.classList.remove("hover");
    hoverTile = null;
    rearmUntil = now + pace.rearmMs;
  }
  // Sticky: keep the current tile while the cursor is near it, so jitter at edges doesn't reset it.
  const hit =
    hoverTile && inRect(hoverTile, x, y, TILE_STICKY_PX)
      ? hoverTile
      : (board.targets().find((el) => inRect(el, x, y, 0)) ?? null);
  if (hit !== hoverTile) {
    hoverTile?.classList.remove("hover");
    hit?.classList.add("hover");
    hoverTile = hit;
    hoverSince = now;
  }
  const tile = hoverTile;
  const rule = tile ? board.selectRule(tile) : { dwellMs: null, browAllowed: true };
  const browOk = useBrow && rule.browAllowed;
  const dwellMs = rule.dwellMs ?? (useBrow ? null : pace.dwellMs);
  const startedAt = Math.max(hoverSince, rearmUntil); // when the user could start selecting this tile

  let progress = 0;
  let fire = false;
  if (tile && now >= rearmUntil) {
    if (dwellMs !== null) {
      progress = clamp((now - startedAt) / dwellMs, 0, 1);
      fire = progress >= 1;
    }
    if (browOk) {
      progress = Math.max(progress, browLevel);
      fire ||= click && now - hoverSince >= HOVER_SETTLE_MS;
    }
  }
  cursor.classList.toggle("browMode", browOk && rule.dwellMs === null);
  ring.style.strokeDashoffset = String(RING_LEN * (1 - progress));
  if (tile && fire) {
    if (rule.dwellMs === null) fatigue.recordSelection(now - startedAt, now); // normal tiles only
    rearmUntil = now + pace.rearmMs; // refractory period before the next selection
    hoverSince = now;
    board.activate(tile);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- boot ----------
async function main(): Promise<void> {
  ring.style.strokeDasharray = String(RING_LEN);
  try {
    await startCamera(video);
    const lm = await createLandmarker();
    statusEl.textContent = cal
      ? `Loaded saved calibration. ${cal.brow ? "Look at a tile, then raise your eyebrows." : "Look at a tile and hold."}`
      : "Look at the screen…";
    const loop = () => {
      onFrame(lm, performance.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } catch (err) {
    statusEl.textContent = `Startup failed: ${(err as Error).message}`;
    console.error(err);
  }
}
main();
