# SignalSpeak

A hands-free, voice-free communication board for a person with bulbar-onset ALS, controlled entirely by
eye gaze and small facial movements captured by an ordinary laptop webcam.
Built for the Queen's Engineering Competition 2026 Programming Challenge.

> **AI assistance disclosure.** The source code in this repository was written with the help of
> Claude (Anthropic) — Claude Opus 5.5 and Claude Fable 5.1, used through Claude Code — directed by the
> team. Every source file carries an "AI-assisted" comment. The presentation and slides were written by
> the team without generative AI. See [References](#references) for all third-party code and libraries.

## What it does

| Need | How the user does it |
|---|---|
| Point at a tile | Look at it; the gaze cursor follows and the tile lights up |
| Select | Raise the eyebrows while looking at the tile (or look-and-hold if the user's brow raise is too weak) |
| Undo | Look away from the screen before the phrase is spoken |
| Say Yes / No, request water, washroom, repositioning, temperature, pain 1–10 | Home → tile (→ sub-menu). Spoken aloud and pushed to the caregiver's phone |
| Call the caregiver | Caregiver / Assistance → Call caregiver: spoken + high-priority phone notification with an "I'm on my way" button |
| Emergency | Emergency tile, or a gesture that works from any screen (two long blinks by default, changeable under Binds): alarm + caregiver push + phone call; if nobody responds, a text and a *simulated* 911 call |
| Open a website or app (YouTube, news, calculator…) | Macros & Shortcuts; the set of shortcuts is editable by gaze |
| Introduce themselves to a new caregiver | About me: a profile card with a Read-aloud tile |
| Learn the controls | Help button, bottom-right |

The interface adapts to the person: calibration measures *their* gaze and brow range; a fatigue tracker
slows the pace, lowers the brow threshold and falls back to look-and-hold as they tire; head movement is
compensated for but never required, so the app keeps working as head control fades.

## Running it

### Desktop app (recommended)

SignalSpeak is packaged as a Windows desktop app: one full-screen window that starts hands-free (camera
allowed automatically, sound without a click), keeps the screen awake, recovers by itself if the
interface crashes, and works offline.

```bash
npm install
npm run app        # build and start the desktop app
npm run dist       # build the installer: release/SignalSpeak Setup 1.0.0.exe
npm test           # Vitest unit tests (no webcam needed)
```

Close the app with Alt+F4.

**Caregiver notifications (optional, set up once by a caregiver):** copy `.env.example` to
`%APPDATA%\SignalSpeak\config.env` and fill it in. On the next start the app encrypts the settings with
the Windows credential store and deletes the plain-text file. `NTFY_TOPIC` must be a long, hard-to-guess
name; the caregiver subscribes to it in the free ntfy app. The Twilio settings enable the phone call and
text message (trial accounts are limited — see `electron/backend.ts`). `AUTO_START=true` starts
SignalSpeak when the user signs in to Windows.

### In a browser (development)

Requirements: Node.js 20+, Chrome or Edge, a webcam.

```bash
npm run dev        # http://localhost:5173
```

Settings come from `.env.local` (same format, git-ignored, never committed). `start-demo.bat` (or
`npm run demo`) starts the dev server and opens Chrome full-screen with the camera pre-granted.

## How it works

```
webcam → MediaPipe Face Landmarker → gaze features / brow level / eye closure
       → per-user calibration (9 dots · head move · brow raise)
       → event detection (gaze ray → screen, stabiliser, brow click, emergency gesture)
       → fatigue-aware pacing
       → board state machine → speech · caregiver notification · emergency escalation
```

| Layer | Files | Notes |
|---|---|---|
| Sensing | `src/vision/landmarker.ts`, `src/vision/overlay.ts` | MediaPipe setup; face-mesh preview adapted from Google's demo [3] |
| Signals | `src/gaze/features.ts` | Iris-in-eye position (scale-invariant), head pose from the transformation matrix, blink/brow blendshapes |
| Calibration | `src/gaze/calibration.ts`, `geometry.ts`, `regression.ts` | 3D gaze ray from head pose + eye angle, projected to the screen; ridge regression with outlier rejection; per-user eye gain search |
| Smoothing | `src/gaze/stabilizer.ts`, `oneEuro.ts` | Median window → One-Euro filter [6] → dead zone |
| Events | `src/events/brow.ts`, `longBlink.ts`, `emergencyGesture.ts` | Hysteresis + hold + refractory brow click; selectable emergency gestures |
| Adaptation | `src/adapt/fatigue.ts` | Latency, brow amplitude and undo rate → pacing |
| Interface | `src/ui/*`, `src/main.ts` | Menu state machine, undo-before-speaking, alarm, About card, Help |
| Output | `src/tts/speak.ts`, `src/emergency/*`, `src/macros/*` | Web Speech API; requests to the trusted backend for push, call, text and shortcuts |
| Desktop app | `electron/main.ts`, `preload.ts`, `backend.ts`, `secrets.ts`, `security.ts` | Sandboxed window, encrypted settings, ntfy + Twilio, validation and rate limits — see [SECURITY.md](SECURITY.md) |

Every layer below the UI is a pure function or state machine, which is why the test suite can cover
calibration, gesture detection, fatigue pacing and emergency escalation without a webcam.

## Tests

`npm test` runs 94 Vitest tests across `tests/`:

| File | Covers |
|---|---|
| `gaze.test.ts` | iris features, head pose, regression, head-compensated projection, calibration fit, filters, stabiliser |
| `brow.test.ts` | brow calibration, click detection, hysteresis, spike rejection |
| `emergencyGesture.test.ts` | the three emergency gestures and their false-positive cases (resting eyes, normal blinks, early opening) |
| `adapt.test.ts` | long-blink detector, fatigue pacing and recovery, undo window, look-away |
| `escalation.test.ts` | caregiver → text → 911 escalation timing, call-outcome classification |
| `menu.test.ts`, `help.test.ts` | navigation, macros, binds, About me, Help content |

## Privacy and safety notes

- All video processing happens in the browser; no frames leave the machine.
- The 911 call is **simulated** (an on-screen card). Nothing in this prototype contacts emergency services.
- Secrets (Twilio keys, caregiver phone number) live only in `.env.local` on the local dev server and are
  never shipped to the browser or committed.

## References

Numbered in the same bracket style as the challenge brief. Items marked **(code)** are third-party code or
assets included in, or adapted into, this repository; the rest are documentation and design sources.

1. Google AI Edge, "Face Landmark Detection Guide," *MediaPipe Solutions*. https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker — API usage, blendshape names, transformation matrix.
2. **(code)** Google, `@mediapipe/tasks-vision` v1.2.3 (Apache-2.0), npm. https://www.npmjs.com/package/@mediapipe/tasks-vision — face landmarking library; its WebAssembly runtime is copied to `public/wasm/`. Used in `src/vision/landmarker.ts`, `src/vision/overlay.ts`.
3. **(code)** Google, MediaPipe Face Landmarker web example (Apache-2.0), CodePen. https://codepen.io/mediapipe-preview/pen/OJBVQJm — the face-mesh drawing in `src/vision/overlay.ts` (`DrawingUtils`, `FACE_LANDMARKS_*` connection sets) is adapted from this example, as recommended in Appendix A of the brief.
4. **(code)** Google, Face Landmarker model `face_landmarker.task` (float16, v1), Apache-2.0. https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task — stored in `public/face_landmarker.task`.
5. Google AI Edge, MediaPipe Face Mesh canonical landmark topology (eye-corner, lid and iris indices 468–477). https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png — index constants in `src/gaze/features.ts`.
6. G. Casiez, N. Roussel and D. Vogel, "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems," *Proc. CHI 2012*, pp. 2527–2530. https://gery.casiez.net/1euro/ — algorithm implemented in `src/gaze/oneEuro.ts`.
7. **(code)** Evan You et al., *Vite* v8.3.8 (MIT). https://vite.dev — dev server / bundler; project scaffolded with `create-vite` (vanilla-ts template). The `vite.config.ts` plugin is our own.
8. **(code)** *Vitest* v5.1.0 (MIT). https://vitest.dev — test framework for `tests/`.
9. **(code)** Microsoft, *TypeScript* v7.0.2 (Apache-2.0). https://www.typescriptlang.org
10. Philipp C. Heckel, *ntfy* (Apache-2.0 / GPL-2.0). https://ntfy.sh, https://docs.ntfy.sh — HTTP push-notification service used for caregiver alerts and the "I'm on my way" acknowledgement (`electron/backend.ts`).
11. Twilio, "Message Resource," *Programmable Messaging API*. https://www.twilio.com/docs/messaging/api/message-resource — text message in `electron/backend.ts`.
12. Twilio, "Call Resource" and "TwiML `<Say>`," *Programmable Voice*. https://www.twilio.com/docs/voice/api/call-resource, https://www.twilio.com/docs/voice/twiml/say — caregiver phone call in `electron/backend.ts`.
13. Twilio, "Trial account limitations." https://www.twilio.com/docs/usage/trials — explains the fallback to Twilio's sample call/texts on trial accounts.
14. MDN Web Docs, "Web Speech API — SpeechSynthesis." https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis — speech output in `src/tts/speak.ts`.
15. MDN Web Docs, "Web Audio API." https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API — alarm beeps and gesture chirps (`src/ui/alarm.ts`, `src/ui/sound.ts`).
16. MDN Web Docs, "MediaDevices.getUserMedia()." https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia — webcam access.
17. P. Beverloo, "List of Chromium Command Line Switches." https://peter.sh/experiments/chromium-command-line-switches/ — flags used by `start-demo.bat` (`--use-fake-ui-for-media-stream`, `--autoplay-policy`).
18. Microsoft Research, "Smartphone-Based Gaze Gesture Communication for People with Motor Disabilities" (GazeSpeak). https://www.microsoft.com/en-us/research/publication/smartphone-based-gaze-gesture-communication-people-motor-disabilities-2/ — design influence: coarse gaze zones and gaze gestures rather than fine pointing.
19. Anthropic, *Claude* (Claude Opus 5.5 and Claude Fable 5.1, via Claude Code). https://claude.ai — generative-AI assistance (also Claude Fable 5.2) for the source code and tests, as disclosed above.
20. **(code)** OpenJS Foundation, *Electron* v45 (MIT). https://www.electronjs.org — desktop app shell (`electron/`). Hardening follows "Security" in the Electron docs: https://www.electronjs.org/docs/latest/tutorial/security
21. **(code)** *electron-builder* v26 (MIT). https://www.electron.build — builds the Windows installer (`npm run dist`); configuration in `package.json`.
22. **(code)** Evan Wallace, *esbuild* (MIT). https://esbuild.github.io — bundles the Electron main and preload scripts (`scripts/build-electron.mjs`).
23. OWASP, "Cross-Site Request Forgery Prevention Cheat Sheet." https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html — checks on the dev-server API (`isLocalRequest` in `electron/security.ts`).

Icons in `src/ui/icons.ts` are original drawings. The placeholder persona in `src/profile/profile.ts` is
fictional.
