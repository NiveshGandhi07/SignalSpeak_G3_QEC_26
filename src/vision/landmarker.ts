// MediaPipe Face Landmarker setup.
// Adapted from Google AI Edge, "Face Landmark Detection Guide" (web), MediaPipe Solutions [6]:
// https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js
// Library: @mediapipe/tasks-vision (Apache-2.0). Wasm + model are served from /public so it works offline.
// AI-assisted: written with help from Claude (Anthropic).
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export async function createLandmarker(): Promise<FaceLandmarker> {
  const base = import.meta.env.BASE_URL;
  const vision = await FilesetResolver.forVisionTasks(`${base}wasm`);
  const make = (delegate: "GPU" | "CPU") =>
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: `${base}face_landmarker.task`, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  try {
    return await make("GPU");
  } catch {
    return await make("CPU"); // fallback for machines without WebGL2 GPU support
  }
}

export async function startCamera(video: HTMLVideoElement): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}
