// SignalSpeak — gaze cursor prototype.
// Flow (fully hands-free): camera starts -> face held in view ~1.5 s -> calibration
//   phase 1: look at 9 dots in turn
//   phase 2: keep looking at the centre dot while gently moving the head (learns head compensation)
// -> head-pose-compensated gaze model -> stabilised on-screen cursor. Dwell on a tile to select it.
// AI-assisted: written with help from Claude (Anthropic).
import "./style.css";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createLandmarker, startCamera } from "./vision/landmarker";
import { FaceOverlay } from "./vision/overlay";
import { blinkScore, headPose, rawGaze } from "./gaze/features";
import { fitCalibration, predictScreen, type CalSample, type Calibration } from "./gaze/calibration";
import { Stabilizer } from "./gaze/stabilizer";

// ---------- tunables ----------
const FACE_HOLD_MS = 1500; // face must be visible this long before calibration auto-starts
const CAL_POINT_MS = 2000; // time per calibration dot
const CAL_SETTLE_MS = 700; // ignore samples while the eyes travel to the dot
const HEAD_PHASE_MS = 5000; // "keep looking at the dot, move your head gently"
const BLINK_REJECT = 0.45; // drop frames where eyes are mostly closed
const DWELL_MS = 1500; // dwell time to select a tile
const TILE_STICKY_PX = 60; // once on a tile, stay on it until the cursor is this far outside it
const STORAGE_KEY = "signalspeak.gazeCalibration.v2";

// ---------- DOM ----------
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div id="camWrap"><video id="cam" playsinline muted></video><canvas id="mesh"></canvas></div>
  <div id="status">Loading face model…</div>
  <div id="tiles"></div>
  <div id="calDot" hidden></div>
  <div id="cursor" hidden><svg viewBox="0 0 40 40"><circle class="ring" cx="20" cy="20" r="17"/></svg></div>
  <pre id="debug"></pre>
`;
const video = document.querySelector<HTMLVideoElement>("#cam")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const tilesEl = document.querySelector<HTMLDivElement>("#tiles")!;
const calDot = document.querySelector<HTMLDivElement>("#calDot")!;
const cursor = document.querySelector<HTMLDivElement>("#cursor")!;
const ring = cursor.querySelector<SVGCircleElement>(".ring")!;
const debugEl = document.querySelector<HTMLPreElement>("#debug")!;
const overlay = new FaceOverlay(document.querySelector<HTMLCanvasElement>("#mesh")!, video);
const RING_LEN = 2 * Math.PI * 17;

const TILE_LABELS = ["Call caregiver", "Yes", "No", "Water", "Pain", "Recalibrate"];
const tiles = TILE_LABELS.map((label) => {
  const el = document.createElement("div");
  el.className = "tile";
  el.textContent = label;
  tilesEl.appendChild(el);
  return el;
});

// ---------- state ----------
type Mode =
  | { kind: "waitFace"; since: number | null }
  | { kind: "calibrate"; idx: number; start: number; samples: CalSample[] }
  | { kind: "track" };

let mode: Mode = { kind: "waitFace", since: null };
let cal: Calibration | null = loadCalibration();
if (cal) mode = { kind: "track" };

const stab = new Stabilizer();
let dwellTile: HTMLElement | null = null;
let dwellStart = 0;
let lastVideoTime = -1;
let frames = 0, fps = 0, fpsT = performance.now();

/** 9 grid dots, then the centre dot again for the head-movement phase (last entry). */
function calPoints(): [number, number][] {
  const w = window.innerWidth, h = window.innerHeight;
  const xs = [0.08, 0.5, 0.92], ys = [0.1, 0.5, 0.9];
  const grid = ys.flatMap((y) => xs.map((x) => [x * w, y * h] as [number, number]));
  return [...grid, [0.5 * w, 0.5 * h]];
}

function loadCalibration(): Calibration | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Calibration) : null;
  } catch {
    return null;
  }
}
function saveCalibration(c: Calibration): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable — calibration just won't persist */
  }
}

function startCalibration(now: number): void {
  mode = { kind: "calibrate", idx: 0, start: now, samples: [] };
  cursor.hidden = true;
  tilesEl.classList.add("dim");
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
    if (mode.kind === "waitFace") mode.since = null;
    statusEl.textContent = "No face detected — move into view";
    return;
  }
  const g = rawGaze(face, shapes, matrix);
  const blink = blinkScore(shapes);
  const pose = matrix ? headPose(matrix) : { yaw: 0, pitch: 0 };
  const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);
  debugEl.textContent =
    `fps ${fps}  blink ${blink.toFixed(2)}\n` +
    `gx ${g.gx.toFixed(3)} gy ${g.gy.toFixed(3)} lookV ${g.lookV.toFixed(2)}\n` +
    `head yaw ${deg(pose.yaw)}° pitch ${deg(pose.pitch)}°  pos ${g.t.map((v) => v.toFixed(0)).join(",")} cm\n` +
    (cal ? `cal error ${cal.errorPx.toFixed(0)} px  k=(${cal.eye.kx}, ${cal.eye.ky})` : "");

  switch (mode.kind) {
    case "waitFace": {
      mode.since ??= now;
      const left = Math.ceil((FACE_HOLD_MS - (now - mode.since)) / 1000);
      statusEl.textContent = `Face found — sit comfortably. Calibration starts in ${Math.max(left, 0)}…`;
      if (now - mode.since >= FACE_HOLD_MS) startCalibration(now);
      break;
    }
    case "calibrate":
      stepCalibration(mode, g, blink, now);
      break;
    case "track":
      stepTracking(g, blink, now);
      break;
  }
}

function stepCalibration(
  m: Extract<Mode, { kind: "calibrate" }>,
  g: ReturnType<typeof rawGaze>,
  blink: number,
  now: number,
): void {
  const pts = calPoints();
  const headPhase = m.idx === pts.length - 1;
  const dur = headPhase ? HEAD_PHASE_MS : CAL_POINT_MS;
  const t = now - m.start;
  const [px, py] = pts[m.idx];

  statusEl.textContent = headPhase
    ? "Keep your eyes on the dot and gently move your head: left, right, up, down"
    : `Calibration ${m.idx + 1}/${pts.length - 1}: look at the dot`;
  calDot.hidden = false;
  calDot.classList.toggle("pulse", headPhase);
  const scale = headPhase ? 1 : 1 - 0.6 * Math.min(t / dur, 1);
  calDot.style.transform = `translate(${px}px, ${py}px) scale(${scale})`;

  if (t > CAL_SETTLE_MS && blink < BLINK_REJECT) m.samples.push({ raw: g, target: [px, py] });

  if (t >= dur) {
    m.idx++;
    m.start = now;
    if (m.idx >= pts.length) finishCalibration(m.samples);
  }
}

function finishCalibration(samples: CalSample[]): void {
  calDot.hidden = true;
  tilesEl.classList.remove("dim");
  try {
    cal = fitCalibration(samples);
    saveCalibration(cal);
    stab.reset();
    mode = { kind: "track" };
    statusEl.textContent = `Calibrated (avg error ${cal.errorPx.toFixed(0)} px). Look at a tile to select it.`;
  } catch (err) {
    statusEl.textContent = `Calibration failed: ${(err as Error).message}. Retrying…`;
    mode = { kind: "waitFace", since: null };
  }
}

function stepTracking(g: ReturnType<typeof rawGaze>, blink: number, now: number): void {
  if (!cal) return;
  if (blink > BLINK_REJECT) return; // freeze cursor during blinks instead of jumping
  const [rx, ry] = predictScreen(cal, g);
  const [sx, sy] = stab.push(rx, ry, now);
  const x = clamp(sx, 0, window.innerWidth);
  const y = clamp(sy, 0, window.innerHeight);
  cursor.hidden = false;
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  updateDwell(x, y, now);
}

function inRect(el: HTMLElement, x: number, y: number, margin: number): boolean {
  const r = el.getBoundingClientRect();
  return x >= r.left - margin && x <= r.right + margin && y >= r.top - margin && y <= r.bottom + margin;
}

function updateDwell(x: number, y: number, now: number): void {
  // Sticky: keep the current tile while the cursor is near it, so jitter at edges doesn't reset dwell.
  const hit =
    dwellTile && inRect(dwellTile, x, y, TILE_STICKY_PX) ? dwellTile : (tiles.find((el) => inRect(el, x, y, 0)) ?? null);
  if (hit !== dwellTile) {
    dwellTile?.classList.remove("hover");
    hit?.classList.add("hover");
    dwellTile = hit;
    dwellStart = now;
  }
  const p = dwellTile ? clamp((now - dwellStart) / DWELL_MS, 0, 1) : 0;
  ring.style.strokeDashoffset = String(RING_LEN * (1 - p));
  if (dwellTile && p >= 1) {
    select(dwellTile, now);
    dwellStart = now + 1000; // brief refractory period before the same tile can fire again
  }
}

function select(el: HTMLElement, now: number): void {
  el.classList.add("selected");
  setTimeout(() => el.classList.remove("selected"), 600);
  if (el.textContent === "Recalibrate") {
    startCalibration(now);
    return;
  }
  statusEl.textContent = `Selected: ${el.textContent}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- boot ----------
async function main(): Promise<void> {
  ring.style.strokeDasharray = String(RING_LEN);
  try {
    await startCamera(video);
    const lm = await createLandmarker();
    statusEl.textContent = cal ? "Loaded saved calibration. Look at a tile." : "Look at the screen…";
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
