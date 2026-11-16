// Bundles the Electron main process and preload script with esbuild (MIT) https://esbuild.github.io
// Output is CommonJS: a sandboxed preload script must be CommonJS, and main uses __dirname.
// AI-assisted: written with help from Claude (Anthropic).
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], logLevel: "info" };
await build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" });
await build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" });
