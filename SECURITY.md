# SignalSpeak — security notes

SignalSpeak watches a webcam, can phone and text a caregiver, and is used by someone who cannot reach a
keyboard to fix things. This page lists what could go wrong, what the app does about it, and what it
does not protect against. *AI-assisted: written with help from Claude (Anthropic).*

## What we protect

| Asset | Why it matters |
|---|---|
| The alarm path (push → call → text → escalation) | If it can be blocked or falsely "acknowledged", a real emergency goes unanswered |
| Caregiver's phone number, Twilio credentials, ntfy topic | Leaks allow harassment of the caregiver, fake alerts, or a phone bill |
| Webcam video | A camera pointed at a person in bed, all day |
| The user's control of the screen | They cannot recover from a frozen or hijacked interface by hand |

## Design

```
┌───────────────────────── interface (sandboxed page) ─────────────────────────┐
│ camera → MediaPipe → gaze/gestures → board            no Node.js, no network │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ 7 operations only: push · call · callStatus · endCall · sms · checkAck · openMacro
┌───────────────▼──────────── trusted backend (main process) ───────────────────┐
│ validates + rate-limits every request · holds the credentials · ntfy + Twilio │
└────────────────────────────────────────────────────────────────────────────────┘
```

The interface is treated as untrusted even though we wrote it: if a bug ever let foreign content run in
it, that content still could not read a credential, reach the internet, or do anything beyond those
seven operations.

## Threats and mitigations

| Threat | Mitigation | Where |
|---|---|---|
| Webcam video sent off the machine | The page has no network access: CSP `connect-src 'self'` **and** the main process cancels every request that isn't the app's own files. Video frames are processed in memory and never stored. | `electron/security.ts` (CSP), `electron/main.ts` |
| Injected script in the page (XSS) | CSP allows only the app's own script files — no inline script, no `eval`, no remote code. Text placed into the page is escaped. | `CSP`, `src/ui/board.ts`, `aboutCard.ts`, `help.ts` |
| Page compromise leading to control of the PC | Sandbox on, context isolation on, Node integration off. The preload exposes seven fixed functions, not a generic message channel. No new windows, no navigation, no `<webview>`. | `electron/main.ts`, `electron/preload.ts` |
| Stolen credentials | Never sent to the page or put in the build (the ntfy topic used to be compiled into the JavaScript). On disk they are encrypted with the OS credential store (DPAPI); the plain-text setup file is deleted after import. Error messages never include them. | `electron/secrets.ts`, `electron/backend.ts` |
| Fake "I'm on my way" cancelling the 911 escalation | Every alert carries a fresh random code; only an acknowledgement containing that code, sent after the alert, counts. Old taps and blind posts to the topic are ignored. | `ackReceived` in `electron/backend.ts` |
| Using the app to call/text other numbers or send attacker-chosen content elsewhere | The recipient is always the configured caregiver; the page cannot supply a number, topic or URL. Text is length-limited and stripped of control characters; the call script is XML-escaped. | `electron/backend.ts`, `cleanText` |
| Running up the phone bill / bombarding the caregiver | Per-operation rate limits (10 calls and 10 texts per 10 minutes — far above real use). The page can only query or end calls this app placed. | `RateLimiter`, `ownCall` |
| Launching arbitrary programs or links | Shortcuts are looked up in a fixed catalogue in the backend; https only; programs start without a shell, with fixed arguments. | `openMacro` in `electron/backend.ts` |
| Another website calling the local API (dev server only) | Loopback Host + same Origin + JSON content type required, 4 KB body limit, listens on localhost only. The installed app has no HTTP server. | `isLocalRequest`, `vite.config.ts` |
| Reading files outside the app through the `app://` protocol | Paths are normalised and must stay inside `dist/`; only known file types are served. | `resolveAsset` |
| Corrupted or tampered saved data freezing the cursor | Saved calibration is validated field by field; anything invalid is discarded and the app recalibrates. Bind and shortcut settings are checked against the known lists. | `src/gaze/storage.ts`, `parseBinds`, `parseEnabled` |
| Abusing the installed program as a script runner | Electron fuses: run-as-Node, `NODE_OPTIONS` and inspector flags are disabled; the app loads only from its integrity-checked archive. | `electronFuses` in `package.json` |
| Extra permissions | Only the camera (video) is ever granted — never the microphone, location, notifications or screen capture. | `electron/main.ts` |
| Vulnerable dependencies | The shipped app contains Electron + our code + MediaPipe; `npm audit --omit=dev` reports 0 issues. | `package.json` |

The rules above are unit-tested in `tests/security.test.ts` and `tests/backend.test.ts` (with the network
replaced by a fake — the tests never contact ntfy or Twilio).

## Known limits — please read before real-world use

- **The ntfy topic is a shared password, not real authentication.** Anyone who learns it can read the
  alerts (including each alert's acknowledge code) and send fake ones. Keep it long, random and private.
  For real deployments use a self-hosted ntfy server with access tokens, or a push service with accounts.
- **The installer is not code-signed**, so Windows SmartScreen will warn on first run, and users cannot
  verify the publisher. A real release needs a code-signing certificate.
- **No automatic updates.** Security fixes in Electron/Chromium require installing a new version.
- **Someone with access to the unlocked Windows account** can use the app, read its saved (non-secret)
  settings, or replace the settings file. The encryption protects against other accounts and copied
  disks, not against the logged-in user.
- **The 911 step is a simulation.** No emergency service is contacted.
- **The profile card may contain medical details** (`src/profile/profile.ts`); it is shown on screen to
  anyone in the room by design.
- This is a student prototype and has not had an independent security review.

## Reporting a problem

Open an issue on the project's GitHub repository. Please do not include real phone numbers, tokens or
topics in the report.
