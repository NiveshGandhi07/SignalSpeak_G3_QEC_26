// Draws MediaPipe's face mesh + iris landmarks over the camera preview.
// Adapted from Google AI Edge's official Face Landmarker web demo (Apache-2.0) [6]:
// https://codepen.io/mediapipe-preview/pen/OJBVQJm
// https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js
// Uses DrawingUtils + connection sets from @mediapipe/tasks-vision.
// AI-assisted: written with help from Claude (Anthropic).
import { DrawingUtils, FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";

export class FaceOverlay {
  private ctx: CanvasRenderingContext2D;
  private draw: DrawingUtils;
  private canvas: HTMLCanvasElement;
  private video: HTMLVideoElement;

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext("2d")!;
    this.draw = new DrawingUtils(this.ctx);
  }

  render(face: NormalizedLandmark[] | undefined): void {
    const { canvas, video, ctx, draw } = this;
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!face) return;
    const FL = FaceLandmarker;
    draw.drawConnectors(face, FL.FACE_LANDMARKS_TESSELATION, { color: "#C0C0C070", lineWidth: 1 });
    draw.drawConnectors(face, FL.FACE_LANDMARKS_RIGHT_EYE, { color: "#FF3030", lineWidth: 2 });
    draw.drawConnectors(face, FL.FACE_LANDMARKS_RIGHT_EYEBROW, { color: "#FF3030", lineWidth: 2 });
    draw.drawConnectors(face, FL.FACE_LANDMARKS_LEFT_EYE, { color: "#30FF30", lineWidth: 2 });
    draw.drawConnectors(face, FL.FACE_LANDMARKS_LEFT_EYEBROW, { color: "#30FF30", lineWidth: 2 });
    draw.drawConnectors(face, FL.FACE_LANDMARKS_FACE_OVAL, { color: "#E0E0E0", lineWidth: 2 });
    draw.drawConnectors(face, FL.FACE_LANDMARKS_LIPS, { color: "#E0E0E0", lineWidth: 2 });
    draw.drawConnectors(face, FL.FACE_LANDMARKS_RIGHT_IRIS, { color: "#FF3030", lineWidth: 3 });
    draw.drawConnectors(face, FL.FACE_LANDMARKS_LEFT_IRIS, { color: "#30FF30", lineWidth: 3 });
  }
}
