const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const mode = process.env.WRITING_AGENT_ELECTRON_PROBE ?? "ready";
const nonce = process.env.WRITING_AGENT_ELECTRON_PROBE_NONCE ?? "default";
const resultPath = join(app.getPath("temp"), `writing-agent-electron-probe-${nonce}.json`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  if (mode === "window") {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await window.loadURL("data:text/html,<main>Electron probe</main>");
  }
  writeFileSync(resultPath, JSON.stringify({ mode, status: "ready" }));
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
