// Renders public/favicon.svg to build/icon.png (512×512) for the installer and window icon.
// Run with: npx electron scripts/make-icon.cjs   (only needed when the logo changes)
// AI-assisted: written with help from Claude (Anthropic).
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "..", "public", "favicon.svg"), "utf8");
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true, sandbox: true } });
  const page = `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", '<svg width="512" height="512" ')}</body></html>`;
  await win.loadURL("data:text/html;base64," + Buffer.from(page).toString("base64"));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.mkdirSync(path.join(__dirname, "..", "build"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "build", "icon.png"), img.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
