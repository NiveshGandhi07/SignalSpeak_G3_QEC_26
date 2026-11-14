// Head-pose-compensated gaze geometry (pure).
// Idea: build a 3D gaze ray = head rotation ∘ eye-in-head rotation, starting at the head
// position, and intersect it with the camera plane (z = 0, roughly the screen plane on a laptop).
// The resulting point (cm) no longer depends on where the head started, so the per-user
// calibration only has to learn a mild mapping from that plane to screen pixels.
// Eye-in-head angle ≈ k · (iris offset in eye widths); anatomical prior k ≈ 2.5 rad/eye-width
// (eye width ~3 cm, eyeball radius ~1.2 cm), refined per user during calibration.
// AI-assisted: written with help from Claude (Anthropic).
import type { RawGaze } from "./features";

export interface EyeParams {
  cx: number; // gx when looking "straight" (calibration centre)
  cy: number;
  kx: number; // radians per eye-width of iris offset
  ky: number;
}

/** Gaze ray ∩ camera plane, in cm (camera space: x right in raw image, y up). */
export function projectGaze(g: RawGaze, p: EyeParams): [number, number] {
  const yaw = p.kx * (g.gx - p.cx);
  const pitch = -p.ky * (g.gy - p.cy); // iris lower in image = looking down
  // direction in head frame (+z = out of the face, toward the camera)
  const hx = Math.sin(yaw) * Math.cos(pitch);
  const hy = Math.sin(pitch);
  const hz = Math.cos(yaw) * Math.cos(pitch);
  const R = g.R;
  const dx = R[0] * hx + R[1] * hy + R[2] * hz;
  const dy = R[3] * hx + R[4] * hy + R[5] * hz;
  const dz = Math.max(R[6] * hx + R[7] * hy + R[8] * hz, 0.2); // avoid near-parallel rays
  const s = -g.t[2] / dz;
  return [g.t[0] + s * dx, g.t[1] + s * dy];
}
