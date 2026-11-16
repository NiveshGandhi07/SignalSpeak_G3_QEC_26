// Preload: the only bridge between the sandboxed interface and the trusted main process.
// It exposes exactly the seven operations of src/emergency/api.ts as `window.signalspeak` — no
// generic "send any message" function, no Node.js, no Electron objects.
// contextBridge docs: https://www.electronjs.org/docs/latest/api/context-bridge
// AI-assisted: written with help from Claude (Anthropic).
import { contextBridge, ipcRenderer } from "electron";
import type { BackendApi, PushRequest } from "../src/emergency/api.ts";

const ask = <T>(method: keyof BackendApi, payload: object): Promise<T> => ipcRenderer.invoke("signalspeak:backend", method, payload) as Promise<T>;

const api: BackendApi = {
  push: (a: PushRequest) => ask("push", a),
  call: (script: string) => ask("call", { script }),
  callStatus: (sid: string) => ask("callStatus", { sid }),
  endCall: (sid: string) => ask("endCall", { sid }),
  sms: (body: string) => ask("sms", { body }),
  checkAck: (nonce: string, sinceUnix: number) => ask("checkAck", { nonce, sinceUnix }),
  openMacro: (macroId: string) => ask("openMacro", { macroId }),
};

contextBridge.exposeInMainWorld("signalspeak", api);
