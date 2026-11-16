// The only things the user interface may ask the trusted backend to do (types only — no code).
// The interface (a sandboxed web page) never sees credentials and never talks to the network itself:
//   desktop app -> Electron main process over IPC (electron/main.ts, electron/preload.ts)
//   `npm run dev` -> the local dev server (vite.config.ts)
// Both run the same implementation: electron/backend.ts.
// AI-assisted: written with help from Claude (Anthropic).

export interface PushRequest {
  title: string;
  message: string;
  /** emergency look: highest priority + siren tag. Otherwise `priority` (default 3 = normal). */
  urgent?: boolean;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  /** adds the "I'm on my way" button; only an acknowledgement carrying this one-time code is accepted */
  ackNonce?: string;
}

export interface PlacedCall {
  sid: string;
  /** answering-machine detection is on (false on Twilio trial accounts) */
  detection: boolean;
  /** trial account: Twilio's sample message plays instead of our script */
  trial: boolean;
}

export interface CallState {
  status: string;
  answeredBy: string | null;
}

export interface BackendApi {
  push(a: PushRequest): Promise<void>;
  call(script: string): Promise<PlacedCall>;
  callStatus(sid: string): Promise<CallState>;
  endCall(sid: string): Promise<void>;
  sms(body: string): Promise<void>;
  /** has the caregiver tapped "I'm on my way" for this one-time code since `sinceUnix` (seconds)? */
  checkAck(nonce: string, sinceUnix: number): Promise<boolean>;
  openMacro(macroId: string): Promise<void>;
}

export type BackendMethod = keyof BackendApi;

export const BACKEND_METHODS: readonly BackendMethod[] = ["push", "call", "callStatus", "endCall", "sms", "checkAck", "openMacro"];
