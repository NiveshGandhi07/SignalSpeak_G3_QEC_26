// Pure functions: MediaPipe face result -> raw gaze measurements.
// Landmark indices (iris 468-477, eye corners/lids) from the MediaPipe Face Mesh topology [6].
// AI-assisted: written with help from Claude (Anthropic).

export interface Pt {
  x: number;
  y: number;
  z?: number;
}

export interface Blendshape {
  categoryName: string;
  score: number;
}

/** Landmark indices for one eye. Named by the side it appears on in the (un-mirrored) camera image. */
interface EyeIdx {
  outer: number;
  inner: number;
  upper: number;
  lower: number;
  iris: number;
}

export const LEFT_EYE: EyeIdx = { outer: 33, inner: 133, upper: 159, lower: 145, iris: 468 };
export const RIGHT_EYE: EyeIdx = { outer: 263, inner: 362, upper: 386, lower: 374, iris: 473 };

/**
 * Iris position inside the eye, normalised by eye width so it is
 * independent of distance to the camera.
 * x: 0 = at outer corner ... 1 = at inner corner (projected on the corner axis)
 * y: offset from the lid midpoint perpendicular to the eye axis; positive = iris lower in the image.
 */
export function irisInEye(lm: Pt[], e: EyeIdx): { x: number; y: number } {
  const o = lm[e.outer], i = lm[e.inner], iris = lm[e.iris];
  const ax = i.x - o.x, ay = i.y - o.y;
  const w = Math.hypot(ax, ay) || 1e-6;
  const ux = ax / w, uy = ay / w; // unit vector along the eye
  const rx = iris.x - o.x, ry = iris.y - o.y;
  const x = (rx * ux + ry * uy) / w;
  // Perpendicular, oriented so it always points "down" in the image (the two eyes'
  // axes point in opposite directions, so a naive perpendicular would flip sign per eye).
  let nx = -uy, ny = ux;
  if (ny < 0) { nx = -nx; ny = -ny; }
  const midX = (lm[e.upper].x + lm[e.lower].x) / 2;
  const midY = (lm[e.upper].y + lm[e.lower].y) / 2;
  const y = ((iris.x - midX) * nx + (iris.y - midY) * ny) / w;
  return { x, y };
}

/** Yaw / pitch / roll (radians) from MediaPipe's 4x4 column-major facial transformation matrix. */
export function headPose(m: ArrayLike<number>): { yaw: number; pitch: number; roll: number } {
  const r = (row: number, col: number) => m[col * 4 + row];
  const yaw = Math.asin(Math.max(-1, Math.min(1, -r(2, 0))));
  const pitch = Math.atan2(r(2, 1), r(2, 2));
  const roll = Math.atan2(r(1, 0), r(0, 0));
  return { yaw, pitch, roll };
}

function bs(shapes: Blendshape[], name: string): number {
  return shapes.find((s) => s.categoryName === name)?.score ?? 0;
}

/** Everything the gaze model needs from one frame. */
export interface RawGaze {
  /** iris-in-eye horizontal, both eyes averaged; increases as the iris moves toward image +x */
  gx: number;
  /** iris-in-eye vertical, both eyes averaged; increases as the iris moves down */
  gy: number;
  /** eyeLookUp - eyeLookDown blendshapes (helps vertical, where the iris is partly hidden by lids) */
  lookV: number;
  /** head rotation, row-major 3x3, face model -> camera space */
  R: number[];
  /** head position in camera space (cm); z is negative (in front of camera) */
  t: [number, number, number];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function rawGaze(lm: Pt[], shapes: Blendshape[], m: ArrayLike<number> | null): RawGaze {
  const l = irisInEye(lm, LEFT_EYE);
  const r = irisInEye(lm, RIGHT_EYE);
  const gx = (l.x + (1 - r.x)) / 2; // right eye's axis points the other way in the image
  const gy = (l.y + r.y) / 2;
  const lookV =
    (bs(shapes, "eyeLookUpLeft") + bs(shapes, "eyeLookUpRight") -
      bs(shapes, "eyeLookDownLeft") - bs(shapes, "eyeLookDownRight")) / 2;
  if (!m) return { gx, gy, lookV, R: IDENTITY, t: [0, 0, -50] };
  const R = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  return { gx, gy, lookV, R, t: [m[12], m[13], m[14]] };
}

/** Average eye closure 0..1 (1 = fully closed) — used to drop blink frames. */
export function blinkScore(shapes: Blendshape[]): number {
  return (bs(shapes, "eyeBlinkLeft") + bs(shapes, "eyeBlinkRight")) / 2;
}
